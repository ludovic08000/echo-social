/**
 * Per-device identity signing-key resolution (Sesame-style multi-device auth).
 *
 * Problem this solves
 * -------------------
 * In multi-device, each installation generates its OWN identity key pair
 * (`generateIdentityKeys` runs per install), so the Ed25519 signing key that
 * signs a pairwise Double-Ratchet message differs per sending device. The
 * receiver, however, historically verified every message against a single
 * account-level peer signing key (`peerKeyRef.signingKey`, sourced from
 * `user_keys`). Messages from a peer's secondary device therefore failed the
 * secondary Ed25519 check (a false negative), which used to blank the bubble.
 *
 * A pairwise ratchet envelope carries `fp` = the fingerprint of the SENDING
 * device's X25519 identity key (`computeFingerprint(kxPair.publicKey)`). If the
 * backend publishes, per device, the pair (identityFingerprint, signingKeyB64),
 * the receiver can resolve the CORRECT signing key by `envelope.fp` and verify
 * against it.
 *
 * Safety / rollout
 * ----------------
 * `fetchPeerDeviceSigningKeys` is best-effort: until the backend migration adds
 * the per-device identity signing key + an RPC to read it, the fetch returns an
 * EMPTY map, and `resolveSigningKeyForEnvelope` falls back to the account-level
 * key — i.e. exactly today's behaviour. This module is therefore a no-op in
 * production until the backend catches up, and cannot regress existing decrypts.
 */
import { supabase } from '@/integrations/supabase/client';

/** identityFingerprint (== ratchet envelope `fp`) -> Ed25519 signing key (base64). */
export type DeviceSigningKeyMap = Map<string, string>;

export type SigningKeySource = 'device' | 'fallback' | 'none';

export interface ResolvedSigningKey {
  /** Base64 Ed25519 public key to verify with, or undefined if none available. */
  signingKeyB64: string | undefined;
  source: SigningKeySource;
}

/**
 * Resolve the signing key to verify a ratchet envelope against.
 *
 * - If the sending device's fingerprint is known in `map`, use that device's
 *   key (`source: 'device'`) — true per-device verification.
 * - Otherwise fall back to the account-level key (`source: 'fallback'`), which
 *   preserves current behaviour for the primary device and during rollout.
 *
 * Pure function — no IO — so it is trivially unit-testable.
 */
export function resolveSigningKeyForEnvelope(
  map: DeviceSigningKeyMap | null | undefined,
  envelopeFp: string | undefined | null,
  fallbackB64: string | undefined | null,
): ResolvedSigningKey {
  if (envelopeFp && map && map.has(envelopeFp)) {
    const deviceKey = map.get(envelopeFp);
    if (deviceKey) return { signingKeyB64: deviceKey, source: 'device' };
  }
  if (fallbackB64) return { signingKeyB64: fallbackB64, source: 'fallback' };
  return { signingKeyB64: undefined, source: 'none' };
}

/**
 * Best-effort fetch of a peer's per-device identity signing keys.
 *
 * Attempts the (future) RPC `list_device_identity_keys_for_user`. Any error —
 * including the RPC not existing yet — resolves to an EMPTY map so callers
 * transparently fall back to the account-level key. Never throws.
 */
export async function fetchPeerDeviceSigningKeys(userId: string): Promise<DeviceSigningKeyMap> {
  const map: DeviceSigningKeyMap = new Map();
  if (!userId) return map;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('list_device_identity_keys_for_user', {
      p_user_id: userId,
    });
    if (error || !Array.isArray(data)) return map;
    for (const row of data) {
      const fp: string | undefined = row?.identity_fingerprint ?? undefined;
      const key: string | undefined = row?.identity_signing_key ?? undefined;
      if (fp && key) map.set(fp, key);
    }
  } catch {
    /* backend not ready — fall back silently */
  }
  return map;
}
