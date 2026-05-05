import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle, fetchServerIdentityState, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import { refreshSignedPrekeyIfNeeded, refreshDeviceSignedPrekeyIfNeeded, refillDeviceOneTimePrekeysIfNeeded } from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { supabase } from '@/integrations/supabase/client';

export type AutoKeyProvisioningStatus =
  | 'ready'
  | 'locked'
  | 'blocked_temp_device'
  | 'blocked_missing_identity'
  | 'blocked_error';

export interface AutoKeyProvisioningResult {
  ok: boolean;
  status: AutoKeyProvisioningStatus;
  deviceId?: string;
  reason?: string;
}

/**
 * Publishes this account/device receiving material after local E2EE is unlocked.
 * Never creates recipient/provisional keys and never weakens E2EE.
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
    const deviceKx = await getOrCreateDeviceKxKey(deviceId);

    await supabase
      .from('user_devices')
      .upsert({
        user_id: userId,
        device_id: deviceId,
        device_name: typeof navigator !== 'undefined' ? navigator.platform || 'Web' : 'Web',
        device_public_key: deviceKx.publicB64 || bundle.identityKey,
        platform: 'web',
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'user_id,device_id' });

    await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
    await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, keys.signingPrivateKey);
    await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);

    try {
      window.dispatchEvent(new CustomEvent('forsure:own-receiving-keys-ready', {
        detail: { userId, deviceId },
      }));
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
    msg.includes('clés du contact') ||
    msg.includes('contact indisponible') ||
    msg.includes('missing peer')
  );
}
