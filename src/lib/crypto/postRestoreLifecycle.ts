import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, hydrateDeviceId } from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys } from './keyManager';
import {
  refreshSignedPrekeyIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
} from './x3dh';
import { repairCurrentDevicePrekeys } from './devicePrekeyRepair';

export type PostRestoreSource = 'pin' | 'recovery_key' | 'passkey' | 'password' | 'unknown';

async function bumpKeysEpochBestEffort(userId: string): Promise<number | null> {
  try {
    const { data, error } = await (supabase as any).rpc('bump_keys_epoch', { p_user_id: userId });
    if (!error && typeof data === 'number') return data;
  } catch {}

  try {
    const { data } = await (supabase as any)
      .from('user_public_keys')
      .select('keys_epoch')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    const next = Number(data?.keys_epoch ?? 0) + 1;
    const { error } = await (supabase as any)
      .from('user_public_keys')
      .update({ keys_epoch: next, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_active', true);
    if (!error) return next;
  } catch {}

  return null;
}

async function revalidateCurrentDevicePrekeys(userId: string, deviceId: string): Promise<void> {
  const keys = await getOrCreateIdentityKeys(userId);
  if (!keys?.signingPrivateKey) return;

  await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey).catch((err) => {
    console.warn('[POST_RESTORE] shared SPK refresh failed', err);
  });

  await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, keys.signingPrivateKey).catch(async (err) => {
    console.warn('[POST_RESTORE] device SPK refresh failed; attempting repair', err);
    await repairCurrentDevicePrekeys(userId, deviceId, keys.signingPrivateKey, 'post-restore-spk-refresh-failed').catch((repairErr) => {
      console.warn('[POST_RESTORE] device prekey repair failed', repairErr);
    });
  });

  await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId).catch((err) => {
    console.warn('[POST_RESTORE] OPK refill failed', err);
  });
}

async function refreshSignedDeviceListBestEffort(userId: string, deviceId: string): Promise<void> {
  try {
    const { data: deviceRow } = await supabase
      .from('user_devices' as any)
      .select('device_public_key')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();
    const device = deviceRow as { device_public_key?: string } | null;

    if (!device?.device_public_key) return;

    // This is intentionally conservative: the existing signed-device-list
    // module requires primary-device context. We do not fabricate trust here.
    // Instead, we broadcast a post-restore event so the primary/signing flow can
    // re-sign this device if the account policy requires it.
    window.dispatchEvent(new CustomEvent('forsure:e2ee-resign-device-list-needed', {
      detail: { userId, deviceId, devicePublicKey: device.device_public_key, source: 'post-restore' },
    }));
  } catch (err) {
    console.warn('[POST_RESTORE] signed device list refresh request failed', err);
  }
}

export async function runPostRestoreLifecycle(
  userId: string,
  source: PostRestoreSource = 'unknown',
): Promise<{ ok: true; deviceId: string; keysEpoch: number | null } | { ok: false; reason: string }> {
  try {
    const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
    const keysEpoch = await bumpKeysEpochBestEffort(userId);

    await revalidateCurrentDevicePrekeys(userId, deviceId);
    await refreshSignedDeviceListBestEffort(userId, deviceId);
    try {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-post-restore-complete', {
        detail: { userId, deviceId, source, keysEpoch },
      }));
      window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
        detail: { source: `post_restore_${source}`, keysEpoch },
      }));
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
        detail: { source: `post_restore_${source}`, keysEpoch },
      }));
      window.dispatchEvent(new CustomEvent('forsure:sesame-route-ready', {
        detail: { userId, deviceId, source: `post_restore_${source}` },
      }));
    } catch {}

    return { ok: true, deviceId, keysEpoch };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
