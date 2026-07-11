import { supabase } from '@/integrations/supabase/client';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { exportPublicKeyRaw, loadIdentityKeys } from '@/lib/crypto/keyManager';
import {
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

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register fresh device KX/SPK/OPKs, then authenticate its transport key in
 * the signed device list. The account Ed25519 identity arrived inside the
 * approved ECDH transfer; the server never receives its private half.
 */
export async function finalizeLinkedDeviceAfterRestore(
  userId: string,
  companionDeviceId: string,
): Promise<boolean> {
  if (!userId || !companionDeviceId) return false;

  try {
    const { resyncE2EE } = await import('@/lib/crypto/resyncE2EE');
    await resyncE2EE(userId);
  } catch (error) {
    console.warn('[DeviceLinkTrust] device resync failed before trust publish', error);
  }

  const retryDelays = [0, 500, 1_500, 3_000];
  for (const waitMs of retryDelays) {
    await delay(waitMs);

    try {
      const { data, error } = await supabase
        .from('user_devices')
        .select('device_id, device_public_key, is_primary, is_active, approval_status, revoked_at')
        .eq('user_id', userId)
        .eq('is_active', true)
        .eq('approval_status', 'approved');
      if (error) continue;

      const devices = (data ?? []) as DeviceRow[];
      const companion = devices.find((device) => device.device_id === companionDeviceId);
      const primary = devices.find((device) => device.is_primary && !device.revoked_at);
      if (!companion?.device_public_key || !primary) continue;

      if (companion.is_primary) {
        const result = await publishOwnSignedDeviceList({ signerDeviceId: companion.device_id });
        return result.ok;
      }

      const identity = await loadIdentityKeys(userId);
      if (!identity?.signingPrivateKey || !identity.signingPublicKey) continue;

      const primarySigningPublic = bufferToBase64(
        await exportPublicKeyRaw(identity.signingPublicKey),
      );
      const signatureRow = await signCompanionDevice({
        userId,
        primaryDeviceId: primary.device_id,
        primaryEdPrivate: identity.signingPrivateKey,
        primaryEdPublicB64: primarySigningPublic,
        companionDeviceId: companion.device_id,
        companionPublicKeyB64: companion.device_public_key,
      });
      await publishCompanionSignature(signatureRow);

      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-request-refanout-scan', {
          detail: { reason: 'linked_device_trusted', deviceId: companion.device_id },
        }));
      } catch {}
      return true;
    } catch {
      // Device registration and realtime replication can settle on next pass.
    }
  }

  console.warn('[DeviceLinkTrust] linked device remained unsigned after bounded retries', {
    deviceId: companionDeviceId.slice(0, 8),
  });
  return false;
}
