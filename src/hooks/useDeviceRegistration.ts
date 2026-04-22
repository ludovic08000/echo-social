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
} from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto/keyManager';
import { refreshDeviceSignedPrekeyIfNeeded, refillDeviceOneTimePrekeysIfNeeded } from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';

export function useDeviceRegistration() {
  const { user } = useAuth();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!user || ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      try {
        const deviceId = getCurrentDeviceId();
        const keys = await getOrCreateIdentityKeys(user.id);
        const bundle = await exportPublicKeyBundle(keys);

        // Validation: ensure the shared identity is fully restored before publishing
        // anything that other users will pin against. Publishing a half-initialised
        // bundle would let peers cache a wrong identity key for this account.
        if (!bundle?.identityKey || !bundle?.signingKey) {
          console.warn('[useDeviceRegistration] identity bundle incomplete — abort device publish');
          ranRef.current = false; // allow a retry on next mount
          return;
        }
        if (!keys?.privateKey || !keys?.signingPrivateKey) {
          console.warn('[useDeviceRegistration] identity private keys missing — abort device publish');
          ranRef.current = false;
          return;
        }

        const payload = {
          user_id: user.id,
          device_id: deviceId,
          device_name: getCurrentDeviceLabel(),
          // ⚠️ This is the SHARED identity key, not a per-device key. The
          // deviceWrap fallback derives ECDH from this — see deviceWrap.ts for
          // the security implications. Per-device isolation is provided by the
          // X3DH+Ratchet path (steps 2 & 3 below), not by this column.
          device_public_key: bundle.identityKey,
          platform: getCurrentPlatform(),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        };

        // 1. Register the device (idempotent upsert)
        const { error: devErr } = await supabase
          .from('user_devices')
          .upsert(payload, { onConflict: 'user_id,device_id' });
        if (devErr) {
          console.warn('[useDeviceRegistration] device upsert failed:', devErr.message);
          return;
        }

        // 2. Ensure a per-device Signed PreKey exists & is fresh.
        //    This is what makes targeted X3DH per device possible.
        try {
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
        } catch (spkErr) {
          // Non-fatal: fan-out can still fall back to deviceWrap or legacy ratchet.
          console.warn('[useDeviceRegistration] device SPK refresh failed (non-fatal):', spkErr);
        }

        // 3. Refill the OPK pool if low (forward secrecy on bursts).
        //    Non-fatal: X3DH gracefully degrades to 3-DH when no OPK is available.
        try {
          await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
        } catch (opkErr) {
          console.warn('[useDeviceRegistration] OPK refill failed (non-fatal):', opkErr);
        }
      } catch (err) {
        console.warn('[useDeviceRegistration] failed (non-fatal):', err);
      }
    })();
  }, [user]);
}
