/**
 * useDeviceRegistration — registers the current browser as an active device
 * for the logged-in user. Run once per session at app load.
 *
 * Used by the multi-device messaging fan-out:
 *   - sender side: lists active devices of the recipient via RPC
 *   - recipient side: fetches the message copy addressed to its device_id
 *
 * The registered public key is the user's E2EE identity key (already
 * persisted in IndexedDB). This is intentional: each browser/device has its
 * own IndexedDB, so the public key naturally differs between devices unless
 * the user copied keys via the QR/PIN device-link flow (in which case both
 * devices legitimately share the same identity).
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

        const payload = {
          user_id: user.id,
          device_id: deviceId,
          device_name: getCurrentDeviceLabel(),
          device_public_key: bundle.identityKey,
          platform: getCurrentPlatform(),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        };

        // Upsert (insert or refresh last_seen / public key if rotated)
        await supabase
          .from('user_devices')
          .upsert(payload, { onConflict: 'user_id,device_id' });
      } catch (err) {
        // Non-fatal: multi-device is additive. Legacy single-device flow
        // continues to work even if registration fails.
        console.warn('[useDeviceRegistration] failed (non-fatal):', err);
      }
    })();
  }, [user]);
}
