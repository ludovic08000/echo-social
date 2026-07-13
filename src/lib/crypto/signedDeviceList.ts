/**
 * Multi-device signed device list.
 *
 * The primary Ed25519 signing key authenticates each companion's X25519
 * transport key. These key types must never be compared directly: the former
 * verifies signatures, the latter establishes device sessions.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import { base64ToBuffer, bufferToBase64, encodeString } from './utils';
import { exportPublicKeyRaw, loadIdentityKeys } from './keyManager';

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
  return JSON.stringify({ u: args.userId, d: args.deviceId, dp: args.devicePub, ts: args.signedAt });
}

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
  const signature = await hardCrypto.sign(
    'Ed25519' as any,
    args.primaryEdPrivate,
    encodeString(payload),
  );
  return {
    user_id: args.userId,
    device_id: args.companionDeviceId,
    primary_device_id: args.primaryDeviceId,
    primary_pub_b64: args.primaryEdPublicB64,
    signature_b64: bufferToBase64(signature as ArrayBuffer),
    signed_at: signedAt,
  };
}

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
      repairCompanions: false,
    });
  } catch (publishError) {
    console.warn('[signedDeviceList] publishOwnSignedDeviceList failed (non-fatal):', publishError);
  }
}

async function repairApprovedCompanionSignatures(
  userId: string,
  rows: Array<{ device_id: string; device_public_key: string; is_primary: boolean }>,
): Promise<void> {
  const primary = rows.find((row) => row.is_primary);
  if (!primary) return;

  const companions = rows.filter((row) => !row.is_primary && row.device_public_key);
  if (companions.length === 0) return;

  const { data: signatures } = await supabase
    .from('user_device_signatures')
    .select('device_id, primary_device_id, revoked_at')
    .eq('user_id', userId)
    .eq('primary_device_id', primary.device_id)
    .is('revoked_at', null);
  const alreadySigned = new Set((signatures ?? []).map((row) => row.device_id));
  const missing = companions.filter((row) => !alreadySigned.has(row.device_id));
  if (missing.length === 0) return;

  const identity = await loadIdentityKeys(userId);
  if (!identity?.signingPrivateKey || !identity.signingPublicKey) return;
  const primaryPubB64 = bufferToBase64(await exportPublicKeyRaw(identity.signingPublicKey));

  for (const companion of missing) {
    const signatureRow = await signCompanionDevice({
      userId,
      primaryDeviceId: primary.device_id,
      primaryEdPrivate: identity.signingPrivateKey,
      primaryEdPublicB64: primaryPubB64,
      companionDeviceId: companion.device_id,
      companionPublicKeyB64: companion.device_public_key,
    });
    const { error } = await supabase
      .from('user_device_signatures')
      .upsert(signatureRow, { onConflict: 'user_id,device_id,primary_device_id' });
    if (error) {
      console.warn('[signedDeviceList] approved companion auto-sign failed', {
        deviceId: companion.device_id.slice(0, 8),
        error: error.message,
      });
    }
  }
}

export async function publishOwnSignedDeviceList(args?: {
  signerDeviceId?: string | null;
  signatureB64?: string | null;
  repairCompanions?: boolean;
}): Promise<{ ok: boolean; deviceCount?: number; error?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return { ok: false, error: 'NOT_AUTHENTICATED' };

  const { data: rows, error: listError } = await supabase
    .from('user_devices')
    .select('device_id, device_public_key, is_primary')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq('approval_status', 'approved')
    .is('revoked_at', null);
  if (listError) return { ok: false, error: listError.message };

  const approvedRows = (rows ?? []) as Array<{
    device_id: string;
    device_public_key: string;
    is_primary: boolean;
  }>;
  if (args?.repairCompanions !== false) {
    await repairApprovedCompanionSignatures(userId, approvedRows).catch((error) => {
      console.warn('[signedDeviceList] companion auto-repair failed', error);
    });
  }

  const deviceIds = approvedRows
    .map((row) => String(row.device_id || ''))
    .filter((deviceId) => deviceId.length >= 8);

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

export async function fetchSignedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const { data, error } = await supabase.rpc('get_signed_device_list', { p_user_id: userId });
  if (error) throw new Error(`UDS_FETCH_FAILED: ${error.message}`);
  return (data ?? []).map((row: any) => ({
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    isPrimary: row.is_primary,
    primaryDeviceId: row.primary_device_id ?? null,
    primaryPubB64: row.primary_pub_b64 ?? null,
    signatureB64: row.signature_b64 ?? null,
    signedAt: row.signed_at ?? null,
  }));
}

/** The Ed25519 root must be advertised by the primary row itself. */
function resolvePrimarySigningRoot(primary: SignedDeviceEntry | undefined): string | null {
  if (!primary?.primaryPubB64) return null;
  return primary.primaryPubB64;
}

export async function verifySignedDeviceList(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  const primary = list.find((entry) => entry.isPrimary);
  const primarySigningRoot = resolvePrimarySigningRoot(primary);
  const results: DeviceVerificationResult[] = [];

  for (const entry of list) {
    if (entry.isPrimary) {
      results.push({ deviceId: entry.deviceId, ok: true, reason: 'PRIMARY' });
      continue;
    }

    if (!entry.signatureB64 || !entry.primaryPubB64 || !entry.signedAt) {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'NO_SIGNATURE' });
      continue;
    }

    if (
      !primary ||
      entry.primaryDeviceId !== primary.deviceId ||
      !primarySigningRoot ||
      entry.primaryPubB64 !== primarySigningRoot
    ) {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'PRIMARY_PUB_MISMATCH' });
      continue;
    }

    let publicKey: CryptoKey;
    try {
      publicKey = await hardCrypto.importKey(
        'raw',
        base64ToBuffer(primarySigningRoot),
        { name: 'Ed25519' } as any,
        false,
        ['verify'],
      );
    } catch {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'IMPORT_FAILED' });
      continue;
    }

    const payload = canonicalPayload({
      userId,
      deviceId: entry.deviceId,
      devicePub: entry.devicePublicKey,
      signedAt: entry.signedAt,
    });
    const ok = await hardCrypto.verify(
      'Ed25519' as any,
      publicKey,
      base64ToBuffer(entry.signatureB64),
      encodeString(payload),
    );

    results.push({
      deviceId: entry.deviceId,
      ok,
      reason: ok ? 'VALID' : 'BAD_SIGNATURE',
    });
  }

  return results;
}

export async function fetchTrustedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const list = await fetchSignedDeviceList(userId);
  const verifications = await verifySignedDeviceList(userId, list);
  const trusted = new Set(verifications.filter((result) => result.ok).map((result) => result.deviceId));
  return list.filter((entry) => trusted.has(entry.deviceId));
}

export async function fetchVerifiedDeviceList(userId: string): Promise<{
  signedListPresent: boolean;
  trusted: SignedDeviceEntry[];
  verifications: DeviceVerificationResult[];
}> {
  const list = await fetchSignedDeviceList(userId);
  const verifications = await verifySignedDeviceList(userId, list);
  const trusted = new Set(verifications.filter((result) => result.ok).map((result) => result.deviceId));
  return {
    signedListPresent: list.length > 0,
    trusted: list.filter((entry) => trusted.has(entry.deviceId)),
    verifications,
  };
}

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

export const __test__ = { canonicalPayload, resolvePrimarySigningRoot };