import { supabase } from '@/integrations/supabase/client';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { exportPublicKeyRaw, loadIdentityKeys } from '@/lib/crypto/keyManager';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import {
  fetchVerifiedDeviceList,
  publishCompanionSignature,
  publishOwnSignedDeviceList,
  signCompanionDevice,
} from '@/lib/crypto/signedDeviceList';

type DeviceRow = {
  device_id: string;
  device_public_key: string;
  is_primary: boolean;
  is_active: boolean;
  approval_status: string;
  revoked_at: string | null;
};

type SignatureRow = Awaited<ReturnType<typeof signCompanionDevice>>;

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listApprovedDevices(userId: string): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id, device_public_key, is_primary, is_active, approval_status, revoked_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq('approval_status', 'approved')
    .is('revoked_at', null);
  if (error) throw error;
  return (data ?? []) as DeviceRow[];
}

async function isDeviceCryptographicallyReady(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const [verified, spk] = await Promise.all([
    fetchVerifiedDeviceList(userId),
    peekDeviceSignedPrekey(userId, deviceId).catch(() => null),
  ]);
  return Boolean(
    verified.trusted.some((entry) => entry.deviceId === deviceId) && spk,
  );
}

async function buildCompanionSignature(args: {
  userId: string;
  primary: DeviceRow;
  companion: DeviceRow;
  signingPrivateKey: CryptoKey;
  primarySigningPublic: string;
}): Promise<SignatureRow> {
  return signCompanionDevice({
    userId: args.userId,
    primaryDeviceId: args.primary.device_id,
    primaryEdPrivate: args.signingPrivateKey,
    primaryEdPublicB64: args.primarySigningPublic,
    companionDeviceId: args.companion.device_id,
    companionPublicKeyB64: args.companion.device_public_key,
  });
}

async function signOneCompanion(args: {
  userId: string;
  primary: DeviceRow;
  companion: DeviceRow;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
}): Promise<void> {
  const primarySigningPublic = bufferToBase64(
    await exportPublicKeyRaw(args.signingPublicKey),
  );
  const signatureRow = await buildCompanionSignature({
    userId: args.userId,
    primary: args.primary,
    companion: args.companion,
    signingPrivateKey: args.signingPrivateKey,
    primarySigningPublic,
  });
  await publishCompanionSignature(signatureRow);
}

/**
 * Re-sign every approved companion under one PIN-restored account root, then
 * publish all rows in a single database request. This avoids the transient
 * PRIMARY_PUB_MISMATCH state produced when six rows were updated one by one and
 * the signed-list RPC was refreshed after each individual row.
 */
export async function repairApprovedDeviceTrust(userId: string): Promise<number> {
  if (!userId) return 0;

  const devices = await listApprovedDevices(userId);
  const primary = devices.find((device) => device.is_primary);
  if (!primary) throw new Error('DEVICE_TRUST_PRIMARY_MISSING');

  const identity = await loadIdentityKeys(userId);
  if (!identity?.signingPrivateKey || !identity.signingPublicKey) {
    throw new Error('DEVICE_TRUST_ACCOUNT_KEY_LOCKED');
  }

  const companions = devices.filter(
    (device) => !device.is_primary && Boolean(device.device_public_key),
  );
  const primarySigningPublic = bufferToBase64(
    await exportPublicKeyRaw(identity.signingPublicKey),
  );

  const rows = await Promise.all(companions.map((companion) =>
    buildCompanionSignature({
      userId,
      primary,
      companion,
      signingPrivateKey: identity.signingPrivateKey,
      primarySigningPublic,
    }),
  ));

  if (rows.length > 0) {
    const { error } = await supabase
      .from('user_device_signatures')
      .upsert(rows, { onConflict: 'user_id,device_id,primary_device_id' });
    if (error) throw new Error(`DEVICE_TRUST_BATCH_PUBLISH_FAILED:${error.message}`);
  }

  // One list publication after every companion row carries exactly the same
  // root. No intermediate mixed-root list is observable by other clients.
  const published = await publishOwnSignedDeviceList({
    signerDeviceId: primary.device_id,
    repairCompanions: false,
  });
  if (!published.ok) {
    throw new Error(`DEVICE_TRUST_LIST_PUBLISH_FAILED:${published.error ?? 'UNKNOWN'}`);
  }

  return rows.length;
}

export async function finalizeLinkedDeviceAfterRestore(
  userId: string,
  companionDeviceId: string,
): Promise<boolean> {
  if (!userId || !companionDeviceId) throw new Error('LINKED_DEVICE_INVALID');

  try {
    const { resyncE2EE } = await import('@/lib/crypto/resyncE2EE');
    await resyncE2EE(userId);
  } catch (error) {
    console.warn('[DeviceLinkTrust] device resync failed before trust publish', error);
  }

  const retryDelays = [0, 500, 1_500, 3_000, 5_000];
  for (const waitMs of retryDelays) {
    await delay(waitMs);

    try {
      const devices = await listApprovedDevices(userId);
      const companion = devices.find((device) => device.device_id === companionDeviceId);
      const primary = devices.find((device) => device.is_primary);
      if (!companion?.device_public_key || !primary) continue;

      if (companion.is_primary) {
        const result = await publishOwnSignedDeviceList({ signerDeviceId: companion.device_id });
        if (!result.ok) continue;
      } else {
        const identity = await loadIdentityKeys(userId);
        if (!identity?.signingPrivateKey || !identity.signingPublicKey) continue;
        await signOneCompanion({
          userId,
          primary,
          companion,
          signingPrivateKey: identity.signingPrivateKey,
          signingPublicKey: identity.signingPublicKey,
        });
      }

      await repairApprovedDeviceTrust(userId);
      if (!(await isDeviceCryptographicallyReady(userId, companionDeviceId))) continue;

      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan', {
          detail: { reason: 'linked_device_trusted', deviceId: companion.device_id },
        }));
        window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
      } catch {}
      return true;
    } catch {
      // Registration and realtime replication can settle on the next pass.
    }
  }

  console.warn('[DeviceLinkTrust] linked device failed readiness verification', {
    deviceId: companionDeviceId.slice(0, 8),
  });
  throw new Error('LINKED_DEVICE_NOT_READY');
}
