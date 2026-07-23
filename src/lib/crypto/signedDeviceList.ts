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

type CanonicalRootRow = {
  primary_device_id: string;
  identity_pub_b64: string;
};

type CanonicalRootTable = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => Promise<{
        data: CanonicalRootRow | null;
        error: { message: string } | null;
      }>;
    };
  };
};

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
  reason?:
    | 'PRIMARY'
    | 'VALID'
    | 'NO_SIGNATURE'
    | 'BAD_SIGNATURE'
    | 'PRIMARY_PUB_MISMATCH'
    | 'PRIMARY_COUNT_INVALID'
    | 'PRIMARY_ROOT_MISSING'
    | 'IMPORT_FAILED';
}

function canonicalPayload(args: {
  userId: string;
  primaryDeviceId: string;
  deviceId: string;
  devicePub: string;
}): string {
  // Only immutable, byte-stable values belong in the signed payload. A
  // PostgreSQL timestamptz is metadata: PostgREST may serialize the same
  // instant as either `Z` or `+00:00`, which made freshly published device
  // signatures fail verification after the database round-trip.
  return JSON.stringify({
    protocol: 'forsure-aegis-device',
    version: 1,
    userId: args.userId,
    primaryDeviceId: args.primaryDeviceId,
    deviceId: args.deviceId,
    devicePublicKey: args.devicePub,
  });
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
    primaryDeviceId: args.primaryDeviceId,
    deviceId: args.companionDeviceId,
    devicePub: args.companionPublicKeyB64,
  });
  const signature = await hardCrypto.sign(
    'Ed25519',
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

  // A companion signature authenticates one X25519 device key. It is not a
  // signature over the advisory device list and must never be reused as one.
  const published = await publishOwnSignedDeviceList({
    signerDeviceId: row.primary_device_id,
    repairCompanions: false,
  });
  if (!published.ok) {
    throw new Error(`SIGNED_DEVICE_LIST_PUBLISH_FAILED:${published.error ?? 'UNKNOWN'}`);
  }
}

async function repairApprovedCompanionSignatures(
  userId: string,
  rows: Array<{ device_id: string; device_public_key: string; is_primary: boolean }>,
): Promise<number> {
  const primaries = rows.filter((row) => row.is_primary);
  if (primaries.length !== 1) {
    throw new Error(`SIGNED_DEVICE_PRIMARY_COUNT_INVALID:${primaries.length}`);
  }
  const primary = primaries[0];

  const companions = rows.filter((row) => !row.is_primary && row.device_public_key);
  const identity = await loadIdentityKeys(userId);
  if (!identity?.signingPrivateKey || !identity.signingPublicKey) {
    throw new Error('DEVICE_TRUST_ACCOUNT_KEY_LOCKED');
  }
  const primaryPubB64 = bufferToBase64(await exportPublicKeyRaw(identity.signingPublicKey));

  const canonicalRoot = await loadCanonicalRoot(userId);
  if (!canonicalRoot) {
    throw new Error('IDENTITY_ROOT_MISSING');
  }
  if (canonicalRoot.identityPubB64 !== primaryPubB64) {
    throw new Error('IDENTITY_ROOT_MISMATCH');
  }
  if (canonicalRoot.primaryDeviceId !== primary.device_id) {
    throw new Error('CANONICAL_PRIMARY_DEVICE_MISMATCH');
  }
  if (companions.length === 0) return 0;

  const { data: signatures, error: signaturesError } = await supabase
    .from('user_device_signatures')
    .select('device_id, primary_device_id, primary_pub_b64, signature_b64, revoked_at')
    .eq('user_id', userId)
    .eq('primary_device_id', primary.device_id)
    .is('revoked_at', null);
  if (signaturesError) {
    throw new Error(`SIGNED_DEVICE_SIGNATURES_FETCH_FAILED:${signaturesError.message}`);
  }

  const validDeviceIds = new Set<string>();
  for (const companion of companions) {
    const existing = (signatures ?? []).find((row) =>
      row.device_id === companion.device_id &&
      row.primary_device_id === primary.device_id &&
      row.primary_pub_b64 === primaryPubB64 &&
      typeof row.signature_b64 === 'string' &&
      row.signature_b64.trim().length > 0,
    );
    if (!existing?.signature_b64) continue;

    const payload = canonicalPayload({
      userId,
      primaryDeviceId: primary.device_id,
      deviceId: companion.device_id,
      devicePub: companion.device_public_key,
    });
    try {
      const valid = await hardCrypto.verify(
        'Ed25519',
        identity.signingPublicKey,
        base64ToBuffer(existing.signature_b64),
        encodeString(payload),
      );
      if (valid) validDeviceIds.add(companion.device_id);
    } catch {
      // Invalid Base64 and invalid Ed25519 signatures are both repaired below.
    }
  }

  const missing = companions.filter((row) => !validDeviceIds.has(row.device_id));
  if (missing.length === 0) return 0;

  const repairedRows = await Promise.all(missing.map((companion) =>
    signCompanionDevice({
      userId,
      primaryDeviceId: primary.device_id,
      primaryEdPrivate: identity.signingPrivateKey,
      primaryEdPublicB64: primaryPubB64,
      companionDeviceId: companion.device_id,
      companionPublicKeyB64: companion.device_public_key,
    }),
  ));
  const { error: repairError } = await supabase
    .from('user_device_signatures')
    .upsert(repairedRows, { onConflict: 'user_id,device_id,primary_device_id' });
  if (repairError) {
    throw new Error(`SIGNED_DEVICE_SIGNATURE_REPAIR_FAILED:${repairError.message}`);
  }

  return repairedRows.length;
}

export async function publishOwnSignedDeviceList(args?: {
  signerDeviceId?: string | null;
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
    .is('revoked_at', null)
    .is('stale_at', null);
  if (listError) return { ok: false, error: listError.message };

  const approvedRows = (rows ?? []) as Array<{
    device_id: string;
    device_public_key: string;
    is_primary: boolean;
  }>;
  const primaryCount = approvedRows.filter((row) => row.is_primary).length;
  if (primaryCount !== 1) {
    return { ok: false, error: `PRIMARY_COUNT_INVALID:${primaryCount}` };
  }

  if (args?.repairCompanions !== false) {
    try {
      await repairApprovedCompanionSignatures(userId, approvedRows);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const deviceIds = approvedRows
    .map((row) => String(row.device_id || ''))
    .filter((deviceId) => deviceId.length >= 8);

  const rpcArgs = {
    p_device_ids: deviceIds,
    ...(args?.signerDeviceId ? { p_signer_device_id: args.signerDeviceId } : {}),
  };
  const { data, error } = await supabase.rpc('upsert_signed_device_list', rpcArgs);
  if (error) return { ok: false, error: error.message };

  const result = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  return {
    ok: result?.ok === true,
    deviceCount: typeof result?.device_count === 'number' ? result.device_count : undefined,
    error: result?.ok === true ? undefined : String(result?.code || 'UPSERT_FAILED'),
  };
}

export async function fetchSignedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const { data, error } = await supabase.rpc('get_signed_device_list', { p_user_id: userId });
  if (error) throw new Error(`UDS_FETCH_FAILED: ${error.message}`);
  return (data ?? []).map((row) => ({
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    isPrimary: row.is_primary,
    primaryDeviceId: row.primary_device_id ?? null,
    primaryPubB64: row.primary_pub_b64 ?? null,
    signatureB64: row.signature_b64 ?? null,
    signedAt: row.signed_at ?? null,
  }));
}

/** The canonical Ed25519 root is advertised on the unique primary row. */
function resolvePrimarySigningRoot(primary: SignedDeviceEntry | undefined): string | null {
  if (!primary?.primaryPubB64 || primary.primaryPubB64.trim().length === 0) return null;
  return primary.primaryPubB64;
}

function rejectWholeList(
  list: SignedDeviceEntry[],
  reason: DeviceVerificationResult['reason'],
): DeviceVerificationResult[] {
  return list.map((entry) => ({ deviceId: entry.deviceId, ok: false, reason }));
}

async function loadCanonicalRoot(userId: string): Promise<{
  primaryDeviceId: string;
  identityPubB64: string;
} | null> {
  const rootTable = (supabase.from as unknown as (table: string) => CanonicalRootTable)(
    'user_identity_roots',
  );
  const { data, error } = await rootTable
    .select('primary_device_id, identity_pub_b64')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.primary_device_id || !data?.identity_pub_b64) return null;
  return {
    primaryDeviceId: String(data.primary_device_id),
    identityPubB64: String(data.identity_pub_b64),
  };
}

export async function verifySignedDeviceList(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  const primaries = list.filter((entry) => entry.isPrimary);
  if (primaries.length !== 1) {
    return rejectWholeList(list, 'PRIMARY_COUNT_INVALID');
  }

  const primary = primaries[0];
  const primarySigningRoot = resolvePrimarySigningRoot(primary);
  const canonicalRoot = await loadCanonicalRoot(userId);
  if (!primarySigningRoot || !canonicalRoot) {
    return rejectWholeList(list, 'PRIMARY_ROOT_MISSING');
  }
  if (
    canonicalRoot.primaryDeviceId !== primary.deviceId ||
    canonicalRoot.identityPubB64 !== primarySigningRoot ||
    primary.primaryDeviceId !== null
  ) {
    return rejectWholeList(list, 'PRIMARY_PUB_MISMATCH');
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(primarySigningRoot),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    return rejectWholeList(list, 'IMPORT_FAILED');
  }

  const results: DeviceVerificationResult[] = [
    { deviceId: primary.deviceId, ok: true, reason: 'PRIMARY' },
  ];

  for (const entry of list) {
    if (entry.isPrimary) continue;

    if (!entry.signatureB64 || !entry.primaryPubB64 || !entry.signedAt) {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'NO_SIGNATURE' });
      continue;
    }

    if (
      entry.primaryDeviceId !== primary.deviceId ||
      entry.primaryPubB64 !== primarySigningRoot
    ) {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'PRIMARY_PUB_MISMATCH' });
      continue;
    }

    const payload = canonicalPayload({
      userId,
      primaryDeviceId: primary.deviceId,
      deviceId: entry.deviceId,
      devicePub: entry.devicePublicKey,
    });

    let ok = false;
    try {
      ok = await hardCrypto.verify(
        'Ed25519',
        publicKey,
        base64ToBuffer(entry.signatureB64),
        encodeString(payload),
      );
    } catch {
      ok = false;
    }

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

export const __test__ = { canonicalPayload, resolvePrimarySigningRoot, rejectWholeList };
