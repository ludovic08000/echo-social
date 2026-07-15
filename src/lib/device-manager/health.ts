import { fetchVerifiedDeviceList } from '@/lib/crypto/signedDeviceList';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
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

export async function inspectDeviceHealth(
  userId: string,
  deviceId: string,
): Promise<DeviceHealthReport> {
  const [lifecycle, verified, spk] = await Promise.all([
    readManagedDeviceLifecycle(userId, deviceId),
    fetchVerifiedDeviceList(userId),
    peekDeviceSignedPrekey(userId, deviceId).catch(() => null),
  ]);

  const rejectionReasons: Record<string, number> = {};
  for (const result of verified.verifications) {
    if (result.ok) continue;
    const reason = result.reason ?? 'UNKNOWN';
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }

  const trusted = verified.trusted.some((entry) => entry.deviceId === deviceId);
  const hasSignedPrekey = Boolean(spk);
  return {
    userId,
    deviceId,
    lifecycle: lifecycle.state,
    trusted,
    hasSignedPrekey,
    trustedCount: verified.trusted.length,
    totalCount: verified.verifications.length,
    rejectionReasons,
    ready: lifecycle.state === 'approved' && trusted && hasSignedPrekey,
  };
}
