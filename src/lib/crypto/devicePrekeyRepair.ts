import { supabase } from '@/integrations/supabase/client';
import { runTxOn } from './indexedDbTx';
import {
  generateAndUploadDeviceSignedPrekey,
  refillDeviceOneTimePrekeysIfNeeded,
} from './x3dh';

const SPK_STORE = 'signed-prekeys';

async function purgeLocalDevicePrekeys(userId: string, deviceId: string): Promise<void> {
  const prefixes = [
    `${userId}::dev::${deviceId}::`,
    `${userId}::dev::${deviceId}::opk::`,
  ];

  try {
    await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(SPK_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const key = String(cursor.key);
        if (prefixes.some(prefix => key.startsWith(prefix))) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    }));
  } catch (err) {
    console.warn('[X3DH-REPAIR] local prekey purge failed (non-fatal):', err);
  }
}

async function purgeServerDevicePrekeys(userId: string, deviceId: string): Promise<void> {
  const { error: spkErr } = await supabase
    .from('device_signed_prekeys')
    .update({ is_active: false, is_last_resort: false })
    .eq('user_id', userId)
    .eq('device_id', deviceId);

  if (spkErr) {
    console.warn('[X3DH-REPAIR] device_signed_prekeys invalidate failed:', spkErr.message);
  }

  const { error: opkErr } = await supabase
    .from('device_one_time_prekeys')
    .delete()
    .eq('user_id', userId)
    .eq('device_id', deviceId);

  if (opkErr) {
    console.warn('[X3DH-REPAIR] device_one_time_prekeys purge failed:', opkErr.message);
  }
}

export async function repairCurrentDevicePrekeys(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
  reason: string,
): Promise<{ repaired: boolean; reason: string }> {
  try {
    const { data: deviceRow, error } = await supabase
      .from('user_devices')
      .select('is_active,revoked_at')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (!error && deviceRow && (deviceRow.is_active === false || deviceRow.revoked_at)) {
      console.warn('[X3DH-REPAIR] skipped revoked/inactive device prekey repair', {
        userId,
        deviceId,
        reason,
      });
      return { repaired: false, reason: 'device-revoked-or-inactive' };
    }
  } catch (lookupErr) {
    console.warn('[X3DH-REPAIR] device lifecycle lookup failed (non-fatal):', lookupErr);
  }

  console.warn('[X3DH-REPAIR] repairing current device prekeys', {
    userId,
    deviceId,
    reason,
  });

  await purgeLocalDevicePrekeys(userId, deviceId);
  await purgeServerDevicePrekeys(userId, deviceId);

  await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
  await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);

  try {
    window.dispatchEvent(new CustomEvent('forsure-device-prekeys-repaired', {
      detail: { userId, deviceId, reason },
    }));
  } catch {}

  return { repaired: true, reason };
}
