/**
 * L2 — Sender Keys session orchestrator (Signal "Sender Keys" spec)
 *
 * Pure crypto + state-machine layer that sits between the raw `senderKeys.ts`
 * primitives and the message send pipeline. Handles:
 *
 *   • Owner state: create chain, advance iteration on each send
 *   • Recipient state: install SKDM (chain key + signing pub), fast-forward
 *     to a future iteration when messages arrive out of order
 *   • Rotation: regenerate the entire chain when group membership changes
 *     (member-leave / device-add) to preserve forward secrecy
 *   • Persistence: read/write `sender_key_state` via Supabase
 *
 * The legacy pairwise device ratchet is STILL the transport for the SKDM
 * itself — see `buildSKDM` / `parseSKDM`. This file does NOT touch the
 * message send pipeline yet; that wiring is the next step.
 *
 * Spec: https://signal.org/docs/specifications/sender-key/
 */
import { supabase } from '@/integrations/supabase/client';
import {
  generateSenderKey,
  deriveStep,
  senderKeyEncrypt,
  senderKeyDecrypt,
  buildSKDM,
  parseSKDM,
  type ParsedSKDM,
} from './senderKeys';

const MAX_FAST_FORWARD = 2000; // DoS ceiling on out-of-order skip

export interface OwnerState {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  iteration: number;
  chainKeyB64: string;
  signingPubB64: string;
  signingPrivJwk: JsonWebKey;
}

export interface RecipientState {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  iteration: number;
  chainKeyB64: string;
  signingPubB64: string;
}

// ─── DB persistence ──────────────────────────────────────────────────────

async function loadOwnerState(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<OwnerState | null> {
  const { data, error } = await supabase
    .from('sender_key_state')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('sender_user_id', senderUserId)
    .eq('sender_device_id', senderDeviceId)
    .eq('is_owner', true)
    .maybeSingle();
  if (error || !data) return null;
  if (!data.signing_priv_jwk) return null;
  return {
    conversationId,
    senderUserId,
    senderDeviceId,
    iteration: data.iteration,
    chainKeyB64: data.chain_key_b64,
    signingPubB64: data.signing_pub_b64,
    signingPrivJwk: data.signing_priv_jwk as JsonWebKey,
  };
}

async function saveOwnerState(s: OwnerState): Promise<void> {
  const { error } = await supabase
    .from('sender_key_state')
    .upsert({
      conversation_id: s.conversationId,
      sender_user_id: s.senderUserId,
      sender_device_id: s.senderDeviceId,
      chain_key_b64: s.chainKeyB64,
      iteration: s.iteration,
      signing_pub_b64: s.signingPubB64,
      signing_priv_jwk: s.signingPrivJwk as any,
      is_owner: true,
    }, { onConflict: 'conversation_id,sender_user_id,sender_device_id' });
  if (error) throw new Error(`SK_PERSIST_OWNER_FAILED: ${error.message}`);
}

async function loadRecipientState(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<RecipientState | null> {
  const { data, error } = await supabase
    .from('sender_key_state')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('sender_user_id', senderUserId)
    .eq('sender_device_id', senderDeviceId)
    .eq('is_owner', false)
    .maybeSingle();
  if (error || !data) return null;
  return {
    conversationId,
    senderUserId,
    senderDeviceId,
    iteration: data.iteration,
    chainKeyB64: data.chain_key_b64,
    signingPubB64: data.signing_pub_b64,
  };
}

async function saveRecipientState(s: RecipientState): Promise<void> {
  const { error } = await supabase
    .from('sender_key_state')
    .upsert({
      conversation_id: s.conversationId,
      sender_user_id: s.senderUserId,
      sender_device_id: s.senderDeviceId,
      chain_key_b64: s.chainKeyB64,
      iteration: s.iteration,
      signing_pub_b64: s.signingPubB64,
      signing_priv_jwk: null,
      is_owner: false,
    }, { onConflict: 'conversation_id,sender_user_id,sender_device_id' });
  if (error) throw new Error(`SK_PERSIST_RECIPIENT_FAILED: ${error.message}`);
}

// ─── Owner side (sender) ─────────────────────────────────────────────────

/**
 * Ensure the owner has a chain. Returns existing state if present, else
 * generates a fresh one and persists it. Optionally produces an SKDM that
 * MUST be fanned out via the pairwise ratchet to every recipient device.
 */
export async function ensureOwnerSession(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
  opts: { persist?: boolean } = { persist: true },
): Promise<OwnerState> {
  let state = await loadOwnerState(conversationId, senderUserId, senderDeviceId);
  if (state) return state;

  const fresh = await generateSenderKey();
  state = {
    conversationId,
    senderUserId,
    senderDeviceId,
    iteration: 0,
    chainKeyB64: fresh.chainKeyB64,
    signingPubB64: fresh.signingPubB64,
    signingPrivJwk: fresh.signingPrivJwk,
  };
  if (opts.persist !== false) await saveOwnerState(state);
  return state;
}

/**
 * Build an SKDM payload that captures the CURRENT chain snapshot. Caller
 * sends one per recipient device via the existing pairwise ratchet.
 */
export function snapshotForDistribution(s: OwnerState): string {
  return buildSKDM({
    conversationId: s.conversationId,
    senderUserId: s.senderUserId,
    senderDeviceId: s.senderDeviceId,
    iteration: s.iteration,
    chainKeyB64: s.chainKeyB64,
    signingPubB64: s.signingPubB64,
  });
}

/**
 * Encrypt a group message. Advances the chain by one step and persists
 * the new state. Returns the wire string + iteration used.
 */
export async function encryptForGroup(
  s: OwnerState,
  plaintext: string,
  opts: { persist?: boolean } = { persist: true },
): Promise<{ wire: string; nextState: OwnerState; usedIteration: number }> {
  const usedIteration = s.iteration;
  const { nextChainB64, msgKeyB64 } = await deriveStep(s.chainKeyB64);
  const wire = await senderKeyEncrypt({
    conversationId: s.conversationId,
    senderDeviceId: s.senderDeviceId,
    iteration: usedIteration,
    msgKeyB64,
    signingPrivJwk: s.signingPrivJwk,
    signingPubB64: s.signingPubB64,
    plaintext,
  });
  const nextState: OwnerState = {
    ...s,
    chainKeyB64: nextChainB64,
    iteration: usedIteration + 1,
  };
  if (opts.persist !== false) await saveOwnerState(nextState);
  return { wire, nextState, usedIteration };
}

/**
 * Rotate the entire chain (forward secrecy on member change). The caller
 * MUST broadcast a new SKDM to all CURRENT members after calling this.
 */
export async function rotateOwnerSession(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
  opts: { persist?: boolean } = { persist: true },
): Promise<OwnerState> {
  const fresh = await generateSenderKey();
  const state: OwnerState = {
    conversationId,
    senderUserId,
    senderDeviceId,
    iteration: 0,
    chainKeyB64: fresh.chainKeyB64,
    signingPubB64: fresh.signingPubB64,
    signingPrivJwk: fresh.signingPrivJwk,
  };
  if (opts.persist !== false) await saveOwnerState(state);
  return state;
}

// ─── Recipient side ──────────────────────────────────────────────────────

/**
 * Install (or replace) a recipient state from an SKDM that arrived via the
 * pairwise ratchet. If a newer SKDM (higher iteration baseline) supersedes
 * the previous one — typical after a rotation — we adopt it as-is.
 */
export async function installSKDM(
  skdmPlaintext: string,
  opts: { persist?: boolean } = { persist: true },
): Promise<RecipientState | null> {
  const parsed: ParsedSKDM | null = parseSKDM(skdmPlaintext);
  if (!parsed) return null;
  const state: RecipientState = {
    conversationId: parsed.conversationId,
    senderUserId: parsed.senderUserId,
    senderDeviceId: parsed.senderDeviceId,
    iteration: parsed.iteration,
    chainKeyB64: parsed.chainKeyB64,
    signingPubB64: parsed.signingPubB64,
  };
  if (opts.persist !== false) await saveRecipientState(state);
  return state;
}

/**
 * Decrypt an incoming `sk1.` wire string. Fast-forwards the local chain to
 * the message's iteration if needed (bounded by `MAX_FAST_FORWARD` — past
 * that we treat the gap as a DoS attempt).
 *
 * Out-of-order BEFORE the current iteration is rejected (sender keys do
 * not cache historical message keys — Signal recommends per-recipient
 * pairwise fallback for that edge case).
 */
export async function decryptFromGroup(
  state: RecipientState,
  wire: string,
  opts: { persist?: boolean } = { persist: true },
): Promise<{ plaintext: string | null; nextState: RecipientState }> {
  // Parse iteration out of the wire
  const parts = wire.replace(/^sk1\./, '').split('.');
  if (parts.length !== 7) return { plaintext: null, nextState: state };
  const wireIter = parseInt(parts[2], 10);
  if (!Number.isFinite(wireIter) || wireIter < state.iteration) {
    return { plaintext: null, nextState: state };
  }

  const skip = wireIter - state.iteration;
  if (skip > MAX_FAST_FORWARD) return { plaintext: null, nextState: state };

  // Fast-forward chain to wireIter
  let chain = state.chainKeyB64;
  for (let i = 0; i < skip; i++) {
    const step = await deriveStep(chain);
    chain = step.nextChainB64;
  }

  const plaintext = await senderKeyDecrypt(wire, chain);
  if (plaintext === null) {
    // Auth failed — DO NOT advance state
    return { plaintext: null, nextState: state };
  }

  // Advance one more step past the consumed message
  const after = await deriveStep(chain);
  const nextState: RecipientState = {
    ...state,
    iteration: wireIter + 1,
    chainKeyB64: after.nextChainB64,
  };
  if (opts.persist !== false) await saveRecipientState(nextState);
  return { plaintext, nextState };
}

export const __test__ = {
  loadOwnerState,
  loadRecipientState,
  saveOwnerState,
  saveRecipientState,
};
