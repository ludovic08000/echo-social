/**
 * Sauvegarde/restauration du coffre appareil chiffré dans Supabase.
 *
 * Invariant : le serveur ne reçoit qu'un blob scellé par la Master Key du
 * compte (AES-GCM + AAD user|device). Aucune clé privée, aucune Master Key
 * ne quitte l'appareil. La table `device_encrypted_vaults` est protégée par
 * RLS propriétaire strict.
 */

import { supabase } from '@/integrations/supabase/client';
import {
  captureEncryptedWebDeviceVault,
  restoreEncryptedWebDeviceVault,
  type EncryptedWebDeviceVault,
} from './webDeviceKeyVault';
import { logDeviceVaultEvent } from './deviceVault';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

function isEncryptedVault(value: unknown): value is EncryptedWebDeviceVault {
  const candidate = value as Partial<EncryptedWebDeviceVault> | null;
  return Boolean(
    candidate
      && candidate.version === 1
      && typeof candidate.iv === 'string' && candidate.iv.length > 0
      && typeof candidate.ciphertext === 'string' && candidate.ciphertext.length > 0,
  );
}

function sameEncryptedVault(left: unknown, right: EncryptedWebDeviceVault): boolean {
  return isEncryptedVault(left)
    && left.version === right.version
    && left.iv === right.iv
    && left.ciphertext === right.ciphertext;
}

/**
 * Scelle les clés locales et pousse uniquement le blob chiffré. Le succès
 * n'est retourné qu'après relecture du même user/device et comparaison exacte
 * du vault ; un upsert sans readback n'est jamais considéré durable.
 */
export async function backupDeviceVaultToCloud(args: {
  userId: string;
  deviceId: string;
  platform?: string;
}): Promise<boolean> {
  const { userId, deviceId } = args;
  if (!userId || !DEVICE_ID_RE.test(deviceId)) {
    logDeviceVaultEvent('cloud_backup', 'skipped', { reason: 'scope_invalid' });
    return false;
  }
  try {
    const vault = await captureEncryptedWebDeviceVault(userId, deviceId);
    const { error } = await supabase
      .from('device_encrypted_vaults')
      .upsert({
        user_id: userId,
        device_id: deviceId,
        platform: args.platform ?? 'ios-web',
        vault: vault as unknown as never,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,device_id' });
    if (error) {
      logDeviceVaultEvent('cloud_backup', 'failed', { reason: 'upsert_rejected' });
      return false;
    }

    const { data: readback, error: readbackError } = await supabase
      .from('device_encrypted_vaults')
      .select('vault,platform')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (readbackError || !readback) {
      logDeviceVaultEvent('cloud_backup', 'failed', { reason: 'readback_missing' });
      return false;
    }
    const row = readback as { vault: unknown; platform?: string | null };
    if (!sameEncryptedVault(row.vault, vault)) {
      logDeviceVaultEvent('cloud_backup', 'failed', { reason: 'readback_mismatch' });
      return false;
    }

    logDeviceVaultEvent('cloud_backup', 'ok');
    return true;
  } catch {
    logDeviceVaultEvent('cloud_backup', 'failed', { reason: 'seal_failed' });
    return false;
  }
}

export async function fetchCloudDeviceVault(
  userId: string,
  deviceId: string,
): Promise<EncryptedWebDeviceVault | null> {
  const { data, error } = await supabase
    .from('device_encrypted_vaults')
    .select('vault')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error || !data) return null;
  const vault = (data as { vault: unknown }).vault;
  return isEncryptedVault(vault) ? vault : null;
}

/**
 * Restaure les clés device depuis le coffre cloud vers l'enclave ACE.
 * Fail-closed : exige que le device soit déjà connu côté serveur et que les
 * clés publiques attendues correspondent. Ne crée jamais de DeviceID.
 */
export async function restoreDeviceVaultFromCloud(args: {
  userId: string;
  deviceId: string;
  expectedDeviceSigningKey: string;
  expectedDevicePublicKey: string;
}): Promise<boolean> {
  const vault = await fetchCloudDeviceVault(args.userId, args.deviceId);
  if (!vault) {
    logDeviceVaultEvent('cloud_restore', 'skipped', { reason: 'no_vault' });
    return false;
  }
  try {
    await restoreEncryptedWebDeviceVault({
      userId: args.userId,
      deviceId: args.deviceId,
      vault,
      expectedDeviceSigningKey: args.expectedDeviceSigningKey,
      expectedDevicePublicKey: args.expectedDevicePublicKey,
    });
    logDeviceVaultEvent('cloud_restore', 'ok');
    return true;
  } catch {
    logDeviceVaultEvent('cloud_restore', 'failed', { reason: 'unseal_failed' });
    return false;
  }
}
