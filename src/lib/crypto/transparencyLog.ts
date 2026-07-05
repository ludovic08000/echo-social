import { supabase } from '@/integrations/supabase/client';
import { signedHeadBytes } from './ktMerkle';
import { buildMerkleRootForAudit } from './cryptoPerfWorker';

export type TransparencyEventType =
  | 'identity_bootstrap'
  | 'identity_restored'
  | 'identity_epoch_changed'
  | 'device_linked'
  | 'device_revoked'
  | 'backup_created'
  | 'backup_rotated'
  | 'sender_certificate_issued'
  | 'sealed_sender_event'
  | 'security_warning';

export async function appendTransparencyLog(params: {
  userId: string;
  eventType: TransparencyEventType;
  fingerprint?: string | null;
  identityEpoch?: number | null;
  deviceId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabase.from('e2ee_transparency_log' as any).insert({
      user_id: params.userId,
      event_type: params.eventType,
      fingerprint: params.fingerprint || null,
      identity_epoch: params.identityEpoch || null,
      device_id: params.deviceId || null,
      payload: params.payload || {},
    });
  } catch (error) {
    console.warn('[E2EE][TRANSPARENCY] append skipped', error);
  }
}

export async function fetchTransparencyLog(userId: string, limit = 100) {
  const { data } = await supabase
    .from('e2ee_transparency_log' as any)
    .select('event_type, fingerprint, identity_epoch, device_id, payload, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('KT_INVALID_SIGNATURE_HEX');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyKtSignature(args: {
  publicKeyJwk: JsonWebKey;
  epoch: number | bigint;
  root: string;
  leafCount: number | bigint;
  prevEpoch: number | bigint | null;
  signatureHex: string;
}): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    args.publicKeyJwk,
    { name: 'Ed25519' } as any,
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' } as any,
    key,
    hexToBytes(args.signatureHex),
    signedHeadBytes(args.epoch, args.root, args.leafCount, args.prevEpoch),
  );
}

export interface TransparencyEpochVerification {
  ok: boolean;
  epoch: number | null;
  root: string | null;
  recomputedRoot: string | null;
  leafCount: number;
  signatureValid: boolean;
  rootMatches: boolean;
  error?: string;
}

/**
 * Verify the latest Key Transparency epoch published by the server.
 *
 * This is intentionally read-only and non-throwing for UI callers. A failed
 * verification must be surfaced as a security warning, not silently treated as
 * "no KT". External gossip/auditor consistency checks are still a separate
 * future layer; this validates the signed head + Merkle root locally.
 */
export async function verifyLatestTransparencyEpoch(): Promise<TransparencyEpochVerification> {
  try {
    const { data: head, error: headError } = await (supabase as any).rpc('kt_latest_head');
    if (headError) throw headError;
    const row = Array.isArray(head) ? head[0] : head;
    if (!row) {
      return {
        ok: false,
        epoch: null,
        root: null,
        recomputedRoot: null,
        leafCount: 0,
        signatureValid: false,
        rootMatches: false,
        error: 'KT_HEAD_MISSING',
      };
    }

    const epoch = Number(row.epoch);
    const root = String(row.root || '');
    const leafCount = Number(row.leaf_count ?? 0);
    const prevEpoch = row.prev_epoch === null || row.prev_epoch === undefined ? null : BigInt(row.prev_epoch);
    const publicKeyJwk = row.public_key_jwk as JsonWebKey | undefined;
    const signature = String(row.signature || '');
    if (!Number.isFinite(epoch) || !root || !publicKeyJwk || !signature) {
      throw new Error('KT_HEAD_INCOMPLETE');
    }

    const { data: leavesData, error: leavesError } = await (supabase as any).rpc('kt_get_epoch_leaves', {
      p_epoch: epoch,
    });
    if (leavesError) throw leavesError;
    const leaves = ((leavesData ?? []) as Array<{ leaf_index: number | string; leaf_hash: string }>)
      .slice()
      .sort((a, b) => Number(a.leaf_index) - Number(b.leaf_index))
      .map(l => String(l.leaf_hash || ''))
      .filter(Boolean);
    if (leaves.length !== leafCount) {
      return {
        ok: false,
        epoch,
        root,
        recomputedRoot: null,
        leafCount: leaves.length,
        signatureValid: false,
        rootMatches: false,
        error: 'KT_LEAF_COUNT_MISMATCH',
      };
    }

    const recomputedRoot = await buildMerkleRootForAudit(leaves);
    const rootMatches = recomputedRoot === root;
    const signatureValid = await verifyKtSignature({
      publicKeyJwk,
      epoch: BigInt(epoch),
      root,
      leafCount: BigInt(leafCount),
      prevEpoch,
      signatureHex: signature,
    });
    return {
      ok: rootMatches && signatureValid,
      epoch,
      root,
      recomputedRoot,
      leafCount,
      signatureValid,
      rootMatches,
      ...(rootMatches && signatureValid ? {} : { error: 'KT_VERIFY_FAILED' }),
    };
  } catch (error) {
    return {
      ok: false,
      epoch: null,
      root: null,
      recomputedRoot: null,
      leafCount: 0,
      signatureValid: false,
      rootMatches: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
