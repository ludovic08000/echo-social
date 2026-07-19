import {
  fetchSignedDeviceList,
  type DeviceVerificationResult,
  type SignedDeviceEntry,
  __test__ as signedDeviceListTest,
} from '@/lib/crypto/signedDeviceList';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import { exportPublicKeyRaw, loadIdentityKeys } from '@/lib/crypto/keyManager';
import { bufferToBase64, base64ToBuffer, encodeString } from '@/lib/crypto/utils';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { readManagedDeviceLifecycle } from './lifecycle';

export interface DeviceHealthReport {
  userId: string;
  deviceId: string;
  lifecycle: Awaited<ReturnType<typeof readManagedDeviceLifecycle>>['state'];
  trusted: boolean;
  hasSignedPrekey: boolean;
  trustedCount: number;
  totalCount: number;
  rejectionReasons: Record<string, number>;
  ready: boolean;
}

async function verifyOwnDeviceListWithRestoredRoot(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  const identity = await loadIdentityKeys(userId);
  if (!identity?.signingPublicKey) {
    return list.map((entry) => ({
      deviceId: entry.deviceId,
      ok: entry.isPrimary,
      reason: entry.isPrimary ? 'PRIMARY' : 'NO_SIGNATURE',
    }));
  }

  const primary = list.find((entry) => entry.isPrimary);
  const restoredRoot = bufferToBase64(await exportPublicKeyRaw(identity.signingPublicKey));
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

    // For the authenticated user's own device list, the PIN-restored Ed25519
    // key is the authority. The server's primary row may still expose a stale
    // root during replication, but it must never override the locally restored
    // account key.
    if (
      !primary ||
      entry.primaryDeviceId !== primary.deviceId ||
      entry.primaryPubB64 !== restoredRoot
    ) {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'PRIMARY_PUB_MISMATCH' });
      continue;
    }

    try {
      const publicKey = await hardCrypto.importKey(
        'raw',
        base64ToBuffer(restoredRoot),
        { name: 'Ed25519' } as any,
        false,
        ['verify'],
      );
      const payload = signedDeviceListTest.canonicalPayload({
        userId,
        primaryDeviceId: primary.deviceId,
        deviceId: entry.deviceId,
        devicePub: entry.devicePublicKey,
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
    } catch {
      results.push({ deviceId: entry.deviceId, ok: false, reason: 'IMPORT_FAILED' });
    }
  }

  return results;
}

export async function inspectDeviceHealth(
  userId: string,
  deviceId: string,
): Promise<DeviceHealthReport> {
  const [lifecycle, list, spk] = await Promise.all([
    readManagedDeviceLifecycle(userId, deviceId),
    fetchSignedDeviceList(userId),
    peekDeviceSignedPrekey(userId, deviceId).catch(() => null),
  ]);

  const verifications = await verifyOwnDeviceListWithRestoredRoot(userId, list);
  const trustedIds = new Set(
    verifications.filter((result) => result.ok).map((result) => result.deviceId),
  );

  const rejectionReasons: Record<string, number> = {};
  for (const result of verifications) {
    if (result.ok) continue;
    const reason = result.reason ?? 'UNKNOWN';
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }

  const trusted = trustedIds.has(deviceId);
  const hasSignedPrekey = Boolean(spk);
  return {
    userId,
    deviceId,
    lifecycle: lifecycle.state,
    trusted,
    hasSignedPrekey,
    trustedCount: trustedIds.size,
    totalCount: verifications.length,
    rejectionReasons,
    ready: lifecycle.state === 'approved' && trusted && hasSignedPrekey,
  };
}
