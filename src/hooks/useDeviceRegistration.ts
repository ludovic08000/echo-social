/**
 * useDeviceRegistration — registers the current browser as an active device
 * for the logged-in user, and publishes a per-device Signed PreKey so that
 * other users can perform a targeted X3DH handshake against THIS device.
 *
 * Hybrid multi-device model:
 *   - identity key (IK) and signing key (SIG) are SHARED across the user's
 *     devices (legacy compatible — kept in IndexedDB by getOrCreateIdentityKeys);
 *   - each device has its OWN Signed PreKey + Double Ratchet state, so that
 *     a sender can negotiate an independent secure channel per device.
 *
 * Failure here is NEVER fatal — the legacy single-device flow continues to
 * work even if device or device-SPK registration fails.
 */

import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  hydrateDeviceId,
  isDeviceIdTemporary,
  getDeviceFingerprint,
} from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import {
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  refreshSignedPrekeyIfNeeded,
} from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey, loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';

export function useDeviceRegistration() {
  const { user } = useAuth();
  const ranRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!user) return;

    const registerCurrentDevice = async (reason: string) => {
      if (ranRef.current || inFlightRef.current) return;
      ranRef.current = true;
      inFlightRef.current = true;
      try {
        console.log('[useDeviceRegistration] publishing current device', { reason });
        const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
        if (isDeviceIdTemporary()) {
          console.warn('[useDeviceRegistration] device id still temporary - delaying device publish');
          ranRef.current = false;
          return;
        }
        const keys = await getOrCreateIdentityKeys(user.id);
        const bundle = await exportPublicKeyBundle(keys);

        if (!bundle?.identityKey || !bundle?.signingKey) {
          console.warn('[useDeviceRegistration] identity bundle incomplete — abort device publish');
          ranRef.current = false;
          return;
        }
        if (!keys?.privateKey || !keys?.signingPrivateKey) {
          console.warn('[useDeviceRegistration] identity private keys missing — abort device publish');
          ranRef.current = false;
          return;
        }

        let devicePublicKeyB64 = bundle.identityKey;
        try {
          const { data: existingDeviceRow } = await supabase
            .from('user_devices')
            .select('device_public_key')
            .eq('user_id', user.id)
            .eq('device_id', deviceId)
            .maybeSingle();

          const localKx = await loadDeviceKxKey(deviceId);
          const serverDevicePublicKey = typeof existingDeviceRow?.device_public_key === 'string'
            ? existingDeviceRow.device_public_key
            : null;

          if (serverDevicePublicKey) {
            if (!localKx) {
              console.error('[useDeviceRegistration] ⛔ device_id recovered but local device KX private key is missing — refusing to overwrite server device_public_key', {
                deviceId: deviceId.slice(0, 8),
                serverDevicePublicKeyPreview: serverDevicePublicKey.slice(0, 12),
              });
              window.dispatchEvent(new CustomEvent('forsure:device-kx-restore-required', {
                detail: { userId: user.id, deviceId, reason: 'missing_local_device_kx_private' },
              }));
              ranRef.current = false;
              return;
            }

            if (localKx.publicB64 !== serverDevicePublicKey) {
              console.error('[useDeviceRegistration] ⛔ local device KX public key differs from server — refusing silent device key rotation', {
                deviceId: deviceId.slice(0, 8),
                localPreview: localKx.publicB64.slice(0, 12),
                serverPreview: serverDevicePublicKey.slice(0, 12),
              });
              window.dispatchEvent(new CustomEvent('forsure:device-kx-restore-required', {
                detail: { userId: user.id, deviceId, reason: 'device_kx_public_mismatch' },
              }));
              ranRef.current = false;
              return;
            }

            devicePublicKeyB64 = localKx.publicB64;
          } else {
            const kx = await getOrCreateDeviceKxKey(deviceId);
            if (kx?.publicB64) devicePublicKeyB64 = kx.publicB64;
          }
        } catch (kxErr) {
          console.error('[useDeviceRegistration] ⛔ device KX stability check failed — refusing unsafe fallback to identityKey', kxErr);
          window.dispatchEvent(new CustomEvent('forsure:device-kx-restore-required', {
            detail: { userId: user.id, deviceId, reason: 'device_kx_check_failed' },
          }));
          ranRef.current = false;
          return;
        }

        const deviceFingerprint = await getDeviceFingerprint().catch(() => null);

        const payload = {
          user_id: user.id,
          device_id: deviceId,
          device_name: getCurrentDeviceLabel(),
          device_public_key: devicePublicKeyB64,
          device_fingerprint: deviceFingerprint,
          platform: getCurrentPlatform(),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        };

        const { error: devErr } = await supabase
          .from('user_devices')
          .upsert(payload, { onConflict: 'user_id,device_id' });
        if (devErr) {
          console.warn('[useDeviceRegistration] device upsert failed:', devErr.message);
          return;
        }

        try {
          const { data } = await (supabase as any).rpc('cleanup_stale_user_devices');
          const lifecycleRows = (data || []) as Array<{ device_id: string; action: string }>;
          await Promise.all(
            lifecycleRows
              .filter(row => row.action === 'revoked' && row.device_id !== deviceId)
              .map(row => invalidateDeviceSession(user.id, deviceId, user.id, row.device_id)),
          );
        } catch (cleanupErr) {
          console.warn('[useDeviceRegistration] stale device cleanup failed (non-fatal):', cleanupErr);
        }

        try {
          await refreshSignedPrekeyIfNeeded(user.id, keys.signingPrivateKey);
        } catch (spkErr) {
          console.warn('[useDeviceRegistration] shared SPK refresh failed (non-fatal):', spkErr);
        }

        try {
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
        } catch (spkErr) {
          console.warn('[useDeviceRegistration] device SPK refresh failed (non-fatal):', spkErr);
        }

        try {
          await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
        } catch (opkErr) {
          console.warn('[useDeviceRegistration] OPK refill failed (non-fatal):', opkErr);
        }
      } catch (err) {
        if (err instanceof PinUnlockRequiredError || String(err).toLowerCase().includes('pin unlock required')) {
          ranRef.current = false;
          console.warn('[useDeviceRegistration] PIN_REQUIRED — device publish paused until PIN unlock');
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', { detail: { source: 'useDeviceRegistration' } }));
          } catch {}
          return;
        }
        ranRef.current = false;
        console.warn('[useDeviceRegistration] failed (non-fatal):', err);
      } finally {
        inFlightRef.current = false;
      }
    };

    const onKeysAvailable = () => {
      ranRef.current = false;
      void registerCurrentDevice('keys-unlocked');
    };

    void registerCurrentDevice('auth-mounted');
    window.addEventListener('forsure-keys-unlocked', onKeysAvailable);
    window.addEventListener('forsure-keys-restored', onKeysAvailable);

    return () => {
      window.removeEventListener('forsure-keys-unlocked', onKeysAvailable);
      window.removeEventListener('forsure-keys-restored', onKeysAvailable);
    };
  }, [user]);
}
