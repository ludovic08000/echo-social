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
 *   • Persistence: SECRET material on-device (IndexedDB via senderKeyLocalStore),
 *     NON-secret presence rows on the server (`sender_key_state`).
 *
 * ── SECURITY (audit C1) ────────────────────────────────────────────────────
 * The chain key and the owner signing PRIVATE key NEVER touch the server.
 * They are stored only in the local `sk-state` IndexedDB. The server row holds
 * only conversation/sender/device ids, `is_owner`, the PUBLIC signing key and
 * the iteration counter so multi-device ownership + the rotation watcher keep
 * working without ever exposing decryption/forgery material.
 *
 * Spec: https://signal.org/docs/specifications/sender-key/ (C1 hardened)
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
import {
  getLocalState,
  putLocalState,
  findRecipientStateByWire,
  type LocalSenderKeyState,
} from './senderKeyLocalStore';

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

// ─── NON-secret server presence (no chain key, no private key) ───────────────

/**
 * Upsert a NON-secret presence row so cross-device ownership + the rotation
 * watcher keep working. Best-effort: a failure here must never block the
 * local (authoritative) secret state.
 */
async function upsertServerPresence(args: {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  iteration: number;
  signingPubB64: string;
  isOwner: boolean;
}): Promise<void> {
  try {
    const { error } = await supabase
      .from('sender_key_state')
      .upsert({
        conversation_id: args.conversationId,
        sender_user_id: args.senderUserId,
        sender_device_id: args.senderDeviceId,
        iteration: args.iteration,
        signing_pub_b64: args.signingPubB64,
        is_owner: args.isOwner,
      } as any, { onConflict: 'conversation_id,sender_user_id,sender_device_id' });
    if (error) console.warn('[SK_STATE] presence upsert failed (non-fatal):', error.message);
  } catch (e) {
    console.warn('[SK_STATE] presence upsert threw (non-fatal):', e);
  }
}

// ─── Local secret persistence ────────────────────────────────────────────────

async function loadOwnerState(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<OwnerState | null> {
  const s = await getLocalState(conversationId, senderUserId, senderDeviceId, true);
  if (!s || !s.signingPrivJwk) return null;
  return {
    conversationId: s.conversationId,
    senderUserId: s.senderUserId,
    senderDeviceId: s.senderDeviceId,
    iteration: s.iteration,
    chainKeyB64: s.chainKeyB64,
    signingPubB64: s.signingPubB64,
    signingPrivJwk: s.signingPrivJwk,
  };
}

async function saveOwnerState(s: OwnerState, createdAt?: number): Promise<void> {
  const now = Date.now();
  const existing = await getLocalState(s.conversationId, s.senderUserId, s.senderDeviceId, true);
  const local: LocalSenderKeyState = {
    id: `${s.conversationId}::${s.senderUserId}::${s.senderDeviceId}::o`,
    conversationId: s.conversationId,
    senderUserId: s.senderUserId,
    senderDeviceId: s.senderDeviceId,
    isOwner: true,
    iteration: s.iteration,
    chainKeyB64: s.chainKeyB64,
    signingPubB64: s.signingPubB64,
    signingPrivJwk: s.signingPrivJwk,
    createdAt: createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putLocalState(local);
  await upsertServerPresence({
    conversationId: s.conversationId,
    senderUserId: s.senderUserId,
    senderDeviceId: s.senderDeviceId,
    iteration: s.iteration,
    signingPubB64: s.signingPubB64,
    isOwner: true,
  });
}

async function loadRecipientState(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<RecipientState | null> {
  const s = await getLocalState(conversationId, senderUserId, senderDeviceId, false);
  if (!s) return null;
  return {
    conversationId: s.conversationId,
    senderUserId: s.senderUserId,
    senderDeviceId: s.senderDeviceId,
    iteration: s.iteration,
    chainKeyB64: s.chainKeyB64,
    signingPubB64: s.signingPubB64,
  };
}

async function saveRecipientState(s: RecipientState): Promise<void> {
  const now = Date.now();
  const existing = await getLocalState(s.conversationId, s.senderUserId, s.senderDeviceId, false);
  const local: LocalSenderKeyState = {
    id: `${s.conversationId}::${s.senderUserId}::${s.senderDeviceId}::r`,
    conversationId: s.conversationId,
    senderUserId: s.senderUserId,
    senderDeviceId: s.senderDeviceId,
    isOwner: false,
    iteration: s.iteration,
    chainKeyB64: s.chainKeyB64,
    signingPubB64: s.signingPubB64,
    signingPrivJwk: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putLocalState(local);
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
  if (opts.persist !== false) await saveOwnerState(state, Date.now());
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
  if (opts.persist !== false) await saveOwnerState(state, Date.now());
  return state;
}

// ─── Lot B4 — Auto-rotation thresholds ───────────────────────────────────
//
// WhatsApp/Signal rotate sender keys aggressively to bound the blast radius
// of a key compromise. We auto-rotate when EITHER:
//   • iteration >= MAX_MESSAGES_PER_CHAIN (default 1000), or
//   • the chain has been alive for AGE_LIMIT_MS (default 7 days).
//
// L5 fix: the chain birth time is read from the PERSISTED local state
// (`createdAt`) instead of an in-memory map, so age-based rotation survives
// reloads instead of resetting every session.

const MAX_MESSAGES_PER_CHAIN = 1000;
const CHAIN_AGE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export async function maybeAutoRotate(
  s: OwnerState,
  now: number = Date.now(),
): Promise<{ state: OwnerState; reason: 'count' | 'age' } | null> {
  let reason: 'count' | 'age' | null = null;
  if (s.iteration >= MAX_MESSAGES_PER_CHAIN) {
    reason = 'count';
  } else {
    const local = await getLocalState(s.conversationId, s.senderUserId, s.senderDeviceId, true);
    const createdAt = local?.createdAt ?? now;
    if (now - createdAt >= CHAIN_AGE_LIMIT_MS) reason = 'age';
  }
  if (!reason) return null;

  const next = await rotateOwnerSession(s.conversationId, s.senderUserId, s.senderDeviceId);
  return { state: next, reason };
}

// ─── Recipient side ──────────────────────────────────────────────────────

/**
 * Install (or replace) a recipient state from an SKDM that arrived via the
 * pairwise ratchet.
 *
 * H2 fix: the SKDM plaintext carries the claimed sender (`u`/`d`). Those
 * fields are now bound to the AUTHENTICATED pairwise sender — the caller
 * passes the sender identity proven by the pairwise channel that delivered
 * the SKDM. A mismatch is rejected, closing the group-impersonation hole
 * where a member could distribute an SKDM under another member's identity.
 */
export async function installSKDM(
  skdmPlaintext: string,
  opts: {
    persist?: boolean;
    expectedSender?: { senderUserId: string; senderDeviceId: string };
  } = { persist: true },
): Promise<RecipientState | null> {
  const parsed: ParsedSKDM | null = parseSKDM(skdmPlaintext);
  if (!parsed) return null;

  const expectedSender = opts.expectedSender;
  if (expectedSender) {
    if (
      parsed.senderUserId !== expectedSender.senderUserId ||
      parsed.senderDeviceId !== expectedSender.senderDeviceId
    ) {
      console.warn('[SK_SESSION] SKDM sender mismatch — rejecting (impersonation guard)', {
        claimed_user: parsed.senderUserId,
        claimed_device: parsed.senderDeviceId,
        authenticated_user: expectedSender.senderUserId,
        authenticated_device: expectedSender.senderDeviceId,
      });
      return null;
    }
  }

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
 *
 * H1 fix: the per-message signature is verified against the signing public
 * key pinned in the installed recipient state (`state.signingPubB64`), NOT
 * the key embedded in the wire. This binds provenance to the trusted SKDM
 * and prevents anyone who learns the chain key (e.g. via a server breach)
 * from forging messages with their own freshly-generated signing key.
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

  // H1: pin the trusted signing public key from recipient state.
  const plaintext = await senderKeyDecrypt(wire, chain, state.signingPubB64);
  if (plaintext === null) {
    // Auth failed (signature/key mismatch or AEAD) — DO NOT advance state
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

/**
 * Look up the recipient state matching a `sk1.` wire string. The wire
 * encodes `(conversationId, senderDeviceId)` but NOT the sender user id —
 * so we resolve from the local recipient store.
 *
 * Returns null if no recipient state exists yet (caller should keep the
 * message buffered until the matching SKDM is installed).
 */
export async function loadRecipientStateForWire(wire: string): Promise<RecipientState | null> {
  if (!wire.startsWith('sk1.')) return null;
  const parts = wire.slice(4).split('.');
  if (parts.length !== 7) return null;
  const [conversationId, senderDeviceId] = parts;
  const local = await findRecipientStateByWire(conversationId, senderDeviceId);
  if (!local) return null;
  return {
    conversationId: local.conversationId,
    senderUserId: local.senderUserId,
    senderDeviceId: local.senderDeviceId,
    iteration: local.iteration,
    chainKeyB64: local.chainKeyB64,
    signingPubB64: local.signingPubB64,
  };
}

export const __test__ = {
  loadOwnerState,
  loadRecipientState,
  saveOwnerState,
  saveRecipientState,
};
