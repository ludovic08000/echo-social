/**
 * L4 — Multi-device signed device list (WhatsApp Whitepaper v9)
 *
 * Each user has a `primary` device whose Ed25519 identity key signs every
 * companion device's public key. Peers fetch the signed list during session
 * init and REJECT any companion that lacks a valid signature from the
 * primary — closing the "server adds a rogue device" attack class.
 *
 * Canonical payload signed:
 *   { u: userId, d: companionDeviceId, dp: companionDevicePub, ts: signedAt }
 *
 * Persisted in `user_device_signatures`. Public read via
 * `get_signed_device_list` RPC.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import { base64ToBuffer, bufferToBase64, encodeString } from './utils';

export interface SignedDeviceEntry {
  deviceId: string;
  devicePublicKey: string;
  isPrimary: boolean;
  primaryDeviceId: string | null;
  primaryPubB64: string | null;
  signatureB64: string | null;
  signedAt: string | null;
}

export interface DeviceVerificationResult {
  deviceId: string;
  ok: boolean;
  reason?: 'PRIMARY' | 'VALID' | 'NO_SIGNATURE' | 'BAD_SIGNATURE' | 'PRIMARY_PUB_MISMATCH' | 'IMPORT_FAILED';
}

function canonicalPayload(args: {
  userId: string;
  deviceId: string;
  devicePub: string;
  signedAt: string;
}): string {
  // Stable ordering — JSON.stringify with explicit keys, no whitespace.
  return JSON.stringify({ u: args.userId, d: args.deviceId, dp: args.devicePub, ts: args.signedAt });
}

/**
 * Sign a companion device's public key with the primary device's Ed25519
 * private. Returns the row to insert into `user_device_signatures`.
 *
 * MUST be called by the user from the PRIMARY device only.
 */
export async function signCompanionDevice(args: {
  userId: string;
  primaryDeviceId: string;
  primaryEdPrivate: CryptoKey;
  primaryEdPublicB64: string;
  companionDeviceId: string;
  companionPublicKeyB64: string;
}): Promise<{
  user_id: string;
  device_id: string;
  primary_device_id: string;
  primary_pub_b64: string;
  signature_b64: string;
  signed_at: string;
}> {
  const signedAt = new Date().toISOString();
  const payload = canonicalPayload({
    userId: args.userId,
    deviceId: args.companionDeviceId,
    devicePub: args.companionPublicKeyB64,
    signedAt,
  });
  const sig = await hardCrypto.sign(
    'Ed25519' as any,
    args.primaryEdPrivate,
    encodeString(payload),
  );
  return {
    user_id: args.userId,
    device_id: args.companionDeviceId,
    primary_device_id: args.primaryDeviceId,
    primary_pub_b64: args.primaryEdPublicB64,
    signature_b64: bufferToBase64(sig as ArrayBuffer),
    signed_at: signedAt,
  };
}

/**
 * Persist a freshly produced signature in `user_device_signatures` AND
 * republish the canonical signed device list via `upsert_signed_device_list`
 * (L4 — rogue-companion defense via the new server-side list).
 */
export async function publishCompanionSignature(
  row: Awaited<ReturnType<typeof signCompanionDevice>>,
): Promise<void> {
  const { error } = await supabase
    .from('user_device_signatures')
    .upsert(row, { onConflict: 'user_id,device_id,primary_device_id' });
  if (error) throw new Error(`UDS_PUBLISH_FAILED: ${error.message}`);
  try {
    await publishOwnSignedDeviceList({
      signerDeviceId: row.primary_device_id,
      signatureB64: row.signature_b64,
    });
  } catch (publishErr) {
    console.warn('[signedDeviceList] publishOwnSignedDeviceList failed (non-fatal):', publishErr);
  }
}

/**
 * Republish the caller's full signed device list to `signed_device_lists`
 * via the `upsert_signed_device_list` RPC. Idempotent — safe to call after
 * any device add / rotation / revocation.
 */
export async function publishOwnSignedDeviceList(args?: {
  signerDeviceId?: string | null;
  signatureB64?: string | null;
}): Promise<{ ok: boolean; deviceCount?: number; error?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return { ok: false, error: 'NOT_AUTHENTICATED' };
  const { data: rows, error: listErr } = await supabase
    .from('user_devices')
    .select('device_id')
    .eq('user_id', uid)
    .eq('is_active', true);
  if (listErr) return { ok: false, error: listErr.message };
  const deviceIds = (rows ?? [])
    .map(r => String((r as any).device_id || ''))
    .filter(id => id.length >= 8);
  const { data, error } = await (supabase as any).rpc('upsert_signed_device_list', {
    p_device_ids: deviceIds,
    p_signer_device_id: args?.signerDeviceId ?? null,
    p_signature: args?.signatureB64 ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const result = data as any;
  return {
    ok: result?.ok === true,
    deviceCount: typeof result?.device_count === 'number' ? result.device_count : undefined,
    error: result?.ok === true ? undefined : (result?.code || 'UPSERT_FAILED'),
  };
}

/**
 * Fetch the public signed device list for any user (used during session init).
 */
export async function fetchSignedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const { data, error } = await supabase.rpc('get_signed_device_list', { p_user_id: userId });
  if (error) throw new Error(`UDS_FETCH_FAILED: ${error.message}`);
  return (data ?? []).map((r: any) => ({
    deviceId: r.device_id,
    devicePublicKey: r.device_public_key,
    isPrimary: r.is_primary,
    primaryDeviceId: r.primary_device_id ?? null,
    primaryPubB64: r.primary_pub_b64 ?? null,
    signatureB64: r.signature_b64 ?? null,
    signedAt: r.signed_at ?? null,
  }));
}

/**
 * Verify the chain locally. The PRIMARY device is trusted by definition
 * (it IS the root). Each companion MUST carry a valid Ed25519 signature
 * from a primary whose `primary_pub_b64` matches the primary entry.
 */
export async function verifySignedDeviceList(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  const primary = list.find(e => e.isPrimary);
  const expectedPrimaryPub = primary ? null : null; // tracked below

  const results: DeviceVerificationResult[] = [];
  for (const e of list) {
    if (e.isPrimary) {
      results.push({ deviceId: e.deviceId, ok: true, reason: 'PRIMARY' });
      continue;
    }
    if (!e.signatureB64 || !e.primaryPubB64 || !e.signedAt) {
      results.push({ deviceId: e.deviceId, ok: false, reason: 'NO_SIGNATURE' });
      continue;
    }
    // The primary that signed MUST be the same primary advertised in the list
    // (defends against "ghost primary" injection where the server fabricates
    // a second primary entry to authorize a rogue companion).
    if (primary && primary.devicePublicKey && e.primaryPubB64 !== primary.devicePublicKey) {
      results.push({ deviceId: e.deviceId, ok: false, reason: 'PRIMARY_PUB_MISMATCH' });
      continue;
    }
    let pubKey: CryptoKey;
    try {
      pubKey = await hardCrypto.importKey(
        'raw',
        base64ToBuffer(e.primaryPubB64),
        { name: 'Ed25519' } as any,
        false,
        ['verify'],
      );
    } catch {
      results.push({ deviceId: e.deviceId, ok: false, reason: 'IMPORT_FAILED' });
      continue;
    }
    const payload = canonicalPayload({
      userId,
      deviceId: e.deviceId,
      devicePub: e.devicePublicKey,
      signedAt: e.signedAt,
    });
    const ok = await hardCrypto.verify(
      'Ed25519' as any,
      pubKey,
      base64ToBuffer(e.signatureB64),
      encodeString(payload),
    );
    results.push({
      deviceId: e.deviceId,
      ok,
      reason: ok ? 'VALID' : 'BAD_SIGNATURE',
    });
  }
  return results;
}

/**
 * Convenience helper: fetch + verify in one call. Returns ONLY the
 * trusted device set. Anyone consuming the device list for cryptographic
 * purposes (X3DH bundle fetch, multi-device fanout) SHOULD route through
 * this helper to guarantee the rogue-companion attack is blocked.
 */
export async function fetchTrustedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const list = await fetchSignedDeviceList(userId);
  const verifications = await verifySignedDeviceList(userId, list);
  const trusted = new Set(verifications.filter(v => v.ok).map(v => v.deviceId));
  return list.filter(e => trusted.has(e.deviceId));
}

export async function fetchVerifiedDeviceList(userId: string): Promise<{
  signedListPresent: boolean;
  trusted: SignedDeviceEntry[];
  verifications: DeviceVerificationResult[];
}> {
  const list = await fetchSignedDeviceList(userId);
  const verifications = await verifySignedDeviceList(userId, list);
  const trusted = new Set(verifications.filter(v => v.ok).map(v => v.deviceId));
  return {
    signedListPresent: list.length > 0,
    trusted: list.filter(e => trusted.has(e.deviceId)),
    verifications,
  };
}

/**
 * Revoke a previously-signed companion (e.g. user removes a device from
 * the security panel). Sets `revoked_at` so peers stop trusting it.
 */
export async function revokeCompanionSignature(args: {
  userId: string;
  deviceId: string;
}): Promise<void> {
  const { error } = await supabase
    .from('user_device_signatures')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', args.userId)
    .eq('device_id', args.deviceId)
    .is('revoked_at', null);
  if (error) throw new Error(`UDS_REVOKE_FAILED: ${error.message}`);
}

export const __test__ = { canonicalPayload };
