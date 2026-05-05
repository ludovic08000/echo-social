import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle, fetchServerIdentityState, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import { refreshSignedPrekeyIfNeeded, refreshDeviceSignedPrekeyIfNeeded, refillDeviceOneTimePrekeysIfNeeded } from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey, loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { supabase } from '@/integrations/supabase/client';

export type AutoKeyProvisioningStatus =
  | 'ready'
  | 'locked'
  | 'blocked_temp_device'
  | 'blocked_missing_identity'
  | 'blocked_device_key_restore_required'
  | 'blocked_error';

export interface AutoKeyProvisioningResult {
  ok: boolean;
  status: AutoKeyProvisioningStatus;
  deviceId?: string;
  reason?: string;
}

function emitRestoreRequired(userId: string, deviceId: string, reason: string) {
  try {
    window.dispatchEvent(new CustomEvent('forsure:device-kx-restore-required', {
      detail: { userId, deviceId, reason },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { userId, deviceId, reason },
    }));
  } catch {
    // non-browser/test
  }
}

/**
 * Publishes this account/device receiving material after local E2EE is unlocked.
 *
 * Security rule: if the server already knows a device_public_key for this
 * device_id, the local private device key must exist and match. Otherwise we
 * stop and ask restore; we never overwrite the server with a new device key.
 */
export async function ensureOwnReceivingKeysPublished(userId: string): Promise<AutoKeyProvisioningResult> {
  try {
    const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
    if (isDeviceIdTemporary()) {
      return { ok: false, status: 'blocked_temp_device', deviceId, reason: 'temporary_device_id' };
    }

    const serverIdentity = await fetchServerIdentityState(userId);
    if (!serverIdentity) {
      return { ok: false, status: 'blocked_missing_identity', deviceId, reason: 'missing_server_identity_first_setup_required' };
    }

    const keys = await getOrCreateIdentityKeys(userId);
    const bundle = await exportPublicKeyBundle(keys);

    const { data: existingDevice, error: existingErr } = await supabase
      .from('user_devices')
      .select('device_public_key')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (existingErr) {
      return { ok: false, status: 'blocked_error', deviceId, reason: `device_lookup_failed:${existingErr.message}` };
    }

    let devicePublicKey = bundle.identityKey;
    const serverDevicePublicKey = typeof existingDevice?.device_public_key === 'string'
      ? existingDevice.device_public_key
      : null;

    if (serverDevicePublicKey) {
      const localKx = await loadDeviceKxKey(deviceId);
      if (!localKx) {
        emitRestoreRequired(userId, deviceId, 'missing_local_device_kx_private');
        return { ok: false, status: 'blocked_device_key_restore_required', deviceId, reason: 'missing_local_device_kx_private' };
      }
      if (localKx.publicB64 !== serverDevicePublicKey) {
        emitRestoreRequired(userId, deviceId, 'device_kx_public_mismatch');
        return { ok: false, status: 'blocked_device_key_restore_required', deviceId, reason: 'device_kx_public_mismatch' };
      }
      devicePublicKey = localKx.publicB64;
    } else {
      const localKx = await getOrCreateDeviceKxKey(deviceId);
      if (localKx?.publicB64) devicePublicKey = localKx.publicB64;
    }

    await supabase
      .from('user_devices')
      .upsert({
        user_id: userId,
        device_id: deviceId,
        device_name: typeof navigator !== 'undefined' ? navigator.platform || 'Web' : 'Web',
        device_public_key: devicePublicKey,
        platform: 'web',
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'user_id,device_id' });

    await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
    await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, keys.signingPrivateKey);
    await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);

    try {
      window.dispatchEvent(new CustomEvent('forsure:own-receiving-keys-ready', { detail: { userId, deviceId } }));
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { userId, deviceId, reason: 'own_keys_ready' } }));
    } catch {
      // non-browser/test
    }

    return { ok: true, status: 'ready', deviceId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (error instanceof PinUnlockRequiredError || msg.toLowerCase().includes('pin unlock required')) {
      return { ok: false, status: 'locked', reason: 'pin_unlock_required' };
    }
    return { ok: false, status: 'blocked_error', reason: msg };
  }
}

export function isPeerKeyUnavailableError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('bundle x3dh') ||
    msg.includes('prekey bundle') ||
    msg.includes('signed prekey') ||
    msg.includes('spk') ||
    msg.includes('clés du contact') ||
    msg.includes('contact indisponible') ||
    msg.includes('missing peer')
  );
}
