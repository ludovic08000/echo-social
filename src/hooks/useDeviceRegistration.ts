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
  rotateCurrentDeviceId,
} from '@/lib/messaging/currentDevice';
import {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  fetchServerIdentityState,
  identityBundleMatchesServer,
} from '@/lib/crypto/keyManager';
import {
  refreshDeviceSignedPrekeyIfNeeded,
  repairLocalDevicePrekeys,
  refillDeviceOneTimePrekeysIfNeeded,
  refreshSignedPrekeyIfNeeded,
} from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
import { clearDeviceCryptoInvalid } from '@/lib/messaging/deviceCryptoInvalid';

export function useDeviceRegistration() {
  const { user } = useAuth();
  const registeredRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!user) return;

    const registerDeviceAndPrekeys = async (reason: string) => {
      if (runningRef.current) return;
      if (registeredRef.current && reason !== 'manual-retry') return;
      runningRef.current = true;

      try {
        let deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
        if (isDeviceIdTemporary()) {
          console.warn('[useDeviceRegistration] device id still temporary - delaying device publish');
          registeredRef.current = false;
          return;
        }

        const serverIdentity = await fetchServerIdentityState(user.id);
        if (!serverIdentity) {
          console.info('[useDeviceRegistration] no server E2EE identity yet - first setup must publish identity before device registration');
          registeredRef.current = false;
          return;
        }

        const keys = await getOrCreateIdentityKeys(user.id);
        const bundle = await exportPublicKeyBundle(keys);

        // Validation: ensure the shared identity is fully restored before publishing
        // anything that other users will pin against. Publishing a half-initialised
        // bundle would let peers cache a wrong identity key for this account.
        if (!bundle?.identityKey || !bundle?.signingKey) {
          console.warn('[useDeviceRegistration] identity bundle incomplete — abort device publish');
          registeredRef.current = false;
          return;
        }
        if (!keys?.privateKey || !keys?.signingPrivateKey) {
          console.warn('[useDeviceRegistration] identity private keys missing — abort device publish');
          registeredRef.current = false;
          return;
        }

        if (!identityBundleMatchesServer(bundle, serverIdentity)) {
          console.warn('[useDeviceRegistration] local identity does not match server identity - abort device publish');
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
              detail: {
                userId: user.id,
                reason: 'device_registration_identity_mismatch',
                source: 'useDeviceRegistration',
              },
            }));
          } catch {}
          ranRef.current = false;
          return;
        }

        let { data: previousDeviceRow } = await supabase
          .from('user_devices')
          .select('device_public_key,is_active,revoked_at,revoke_reason,crypto_invalid_at,crypto_invalid_reason,prekey_repair_requested_at')
          .eq('user_id', user.id)
          .eq('device_id', deviceId)
          .maybeSingle();

        if (
          previousDeviceRow?.revoked_at ||
          previousDeviceRow?.revoke_reason === 'USER_DEVICES_REACTIVATION_BLOCKED'
        ) {
          const oldDeviceId = deviceId;
          deviceId = await rotateCurrentDeviceId('server_device_revoked');
          console.warn('[useDeviceRegistration] server revoked this device id - rotated to a fresh device id', {
            oldDeviceId: oldDeviceId.slice(0, 8),
            nextDeviceId: deviceId.slice(0, 8),
          });
          previousDeviceRow = null;
        }

        // Per-device dedicated X25519 key (true cryptographic isolation per device).
        // Generated locally + persisted in IndexedDB; private key never leaves the
        // browser. We publish ONLY the public part. If this key is unavailable,
        // registration stops instead of downgrading to a shared identity key.
        let devicePublicKeyB64: string | null = null;
        try {
          const kx = await getOrCreateDeviceKxKey(deviceId);
          if (kx?.publicB64 && kx?.privateKey) devicePublicKeyB64 = kx.publicB64;
        } catch (kxErr) {
          console.warn('[useDeviceRegistration] device kx key unavailable - abort device publish:', kxErr);
        }
        if (!devicePublicKeyB64) {
          console.warn('[useDeviceRegistration] local device key missing - abort device publish');
          ranRef.current = false;
          return;
        }

        if (
          previousDeviceRow?.device_public_key &&
          previousDeviceRow.device_public_key !== devicePublicKeyB64
        ) {
          console.warn('[useDeviceRegistration] server device public key differs from local key - abort device publish');
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
              detail: {
                userId: user.id,
                deviceId,
                reason: 'device_registration_device_key_mismatch',
                source: 'useDeviceRegistration',
              },
            }));
          } catch {}
          ranRef.current = false;
          return;
        }

        const repairRequested =
          !!previousDeviceRow?.crypto_invalid_at ||
          !!previousDeviceRow?.prekey_repair_requested_at;

        const payload = {
          user_id: user.id,
          device_id: deviceId,
          device_name: getCurrentDeviceLabel(),
          // Per-device X25519 public key (preferred) or shared identity key (legacy fallback).
          // The deviceWrap fallback uses this column; see deviceWrap.ts.
          device_public_key: devicePublicKeyB64,
          platform: getCurrentPlatform(),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        };

        // 1. Register the device (idempotent upsert)
        const { error: devErr } = await supabase
          .from('user_devices')
          .upsert(payload as any, { onConflict: 'user_id,device_id' });
        if (devErr) {
          if (/USER_DEVICES_REACTIVATION_BLOCKED|revoked/i.test(devErr.message ?? '')) {
            await rotateCurrentDeviceId('server_reactivation_blocked');
            ranRef.current = false;
            return;
          }
          console.warn('[useDeviceRegistration] device upsert failed:', devErr.message);
          registeredRef.current = false;
          return;
        }

        // Mark stale/revoke old devices and delete our local sessions to
        // devices that crossed the long inactivity threshold.
        try {
          const { data } = await supabase.rpc('cleanup_stale_user_devices');
          const lifecycleRows = (data || []) as Array<{ device_id: string; action: string }>;
          await Promise.all(
            lifecycleRows
              .filter(row => row.action === 'revoked' && row.device_id !== deviceId)
              .map(row => invalidateDeviceSession(user.id, deviceId, user.id, row.device_id)),
          );
        } catch (cleanupErr) {
          console.warn('[useDeviceRegistration] stale device cleanup failed (non-fatal):', cleanupErr);
        }

        // 2. Ensure the legacy/shared Signed PreKey also exists.
        //    The main conversation X3DH bootstrap still depends on this bundle,
        //    so publishing it here prevents peers from seeing "Bundle X3DH ... indisponible".
        try {
          await refreshSignedPrekeyIfNeeded(user.id, keys.signingPrivateKey);
        } catch (spkErr) {
          console.warn('[useDeviceRegistration] shared SPK refresh failed (non-fatal):', spkErr);
        }

        // 3. Ensure a per-device Signed PreKey exists & is fresh.
        //    This is what makes targeted X3DH per device possible.
        try {
          if (repairRequested) {
            await repairLocalDevicePrekeys(user.id, deviceId, keys.signingPrivateKey);
          } else {
            await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
            await supabase.rpc('clear_device_prekey_repair_needed' as any, {
              p_user_id: user.id,
              p_device_id: deviceId,
            }).catch(() => ({ data: null, error: null }));
            clearDeviceCryptoInvalid(user.id, deviceId);
          }
        } catch (spkErr) {
          // Non-fatal: fan-out can still fall back to deviceWrap or legacy ratchet.
          console.warn('[useDeviceRegistration] device SPK refresh failed (non-fatal):', spkErr);
        }

        // 4. Refill the OPK pool if low (forward secrecy on bursts).
        //    Non-fatal: X3DH gracefully degrades to 3-DH when no OPK is available.
        try {
          await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
        } catch (opkErr) {
          console.warn('[useDeviceRegistration] OPK refill failed (non-fatal):', opkErr);
        }

        registeredRef.current = true;
        console.info('[useDeviceRegistration] device + X3DH prekeys published', { reason, deviceId });
      } catch (err) {
        registeredRef.current = false;
        console.warn('[useDeviceRegistration] failed (non-fatal):', err);
      } finally {
        runningRef.current = false;
      }
    };

    void registerDeviceAndPrekeys('mount');

    const retryAfterUnlock = () => {
      registeredRef.current = false;
      void registerDeviceAndPrekeys('pin-unlock');
    };

    // Critical: first mount can happen while E2EE is LOCKED. In that case
    // getOrCreateIdentityKeys() correctly refuses to create or use keys.
    // Once PIN restore succeeds, retry device registration + SPK/OPK publish.
    window.addEventListener('forsure-keys-unlocked', retryAfterUnlock);
    window.addEventListener('forsure-keys-restored', retryAfterUnlock);

    return () => {
      window.removeEventListener('forsure-keys-unlocked', retryAfterUnlock);
      window.removeEventListener('forsure-keys-restored', retryAfterUnlock);
    };
  }, [user]);
}
