import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary, setCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle, fetchServerIdentityState, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import { refreshSignedPrekeyIfNeeded, refreshDeviceSignedPrekeyIfNeeded, refillDeviceOneTimePrekeysIfNeeded } from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey, loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { supabase } from '@/integrations/supabase/client';

export type AutoKeyProvisioningStatus =
  | 'ready'
  | 'locked'
  | 'blocked_temp_device'
  | 'blocked_missing_identity'
  | 'recreated_device'
  | 'blocked_error';

export interface AutoKeyProvisioningResult {
  ok: boolean;
  status: AutoKeyProvisioningStatus;
  deviceId?: string;
  reason?: string;
}

function randomDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function emitRetry(detail: Record<string, unknown>) {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail }));
  } catch {
    // non-browser/test
  }
}

/**
 * Publishes this account/device receiving material after local E2EE is unlocked.
 *
 * Critical browser rule:
 * If this browser has no private key for the server device_public_key, it cannot
 * decrypt messages addressed to that old device. Instead of endlessly asking for
 * PIN and keeping the app broken, create a NEW device_id and publish fresh device
 * keys/prekeys. Old undecryptable copies remain hidden; future sends use the new
 * valid bundle.
 */
export async function ensureOwnReceivingKeysPublished(userId: string): Promise<AutoKeyProvisioningResult> {
  try {
    let deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
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

    let status: AutoKeyProvisioningStatus = 'ready';
    let devicePublicKey = bundle.identityKey;
    const serverDevicePublicKey = typeof existingDevice?.device_public_key === 'string'
      ? existingDevice.device_public_key
      : null;

    if (serverDevicePublicKey) {
      const localKx = await loadDeviceKxKey(deviceId);

      if (!localKx || localKx.publicB64 !== serverDevicePublicKey) {
        const oldDeviceId = deviceId;
        deviceId = setCurrentDeviceId(randomDeviceId());
        status = 'recreated_device';

        console.warn('[E2EE] Local device key missing/mismatch for existing server device. Creating a fresh browser device.', {
          oldDeviceId: oldDeviceId.slice(0, 8),
          newDeviceId: deviceId.slice(0, 8),
          reason: !localKx ? 'missing_local_device_kx_private' : 'device_kx_public_mismatch',
        });

        try {
          await supabase
            .from('user_devices')
            .update({ is_active: false })
            .eq('user_id', userId)
            .eq('device_id', oldDeviceId);
        } catch {
          // non-fatal; RLS may refuse, but new device still becomes active
        }

        const freshKx = await getOrCreateDeviceKxKey(deviceId);
        devicePublicKey = freshKx.publicB64 || bundle.identityKey;
      } else {
        devicePublicKey = localKx.publicB64;
      }
    } else {
      const localKx = await getOrCreateDeviceKxKey(deviceId);
      if (localKx?.publicB64) devicePublicKey = localKx.publicB64;
    }

    const { error: upsertError } = await supabase
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

    if (upsertError) {
      return { ok: false, status: 'blocked_error', deviceId, reason: `device_upsert_failed:${upsertError.message}` };
    }

    await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
    await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, keys.signingPrivateKey);
    await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);

    emitRetry({ userId, deviceId, reason: status });
    try {
      window.dispatchEvent(new CustomEvent('forsure:own-receiving-keys-ready', { detail: { userId, deviceId, status } }));
    } catch {
      // non-browser/test
    }

    return { ok: true, status, deviceId };
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
