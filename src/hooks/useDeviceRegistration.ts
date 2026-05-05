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
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
import {
  restoreAccountKeysFromActiveSession,
  restoreFromInMemoryMasterKey,
  restoreKeysFromKeychainSnapshot,
} from '@/lib/crypto/accountKeyBackup';

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

        // Per-device dedicated X25519 key (TRUE cryptographic isolation per device).
        //
        // STABILITY CONTRACT (PR #13):
        //   - identity key   = immutable for the account, lives in shared vault
        //   - device key     = immutable for this physical device once published
        //   - SPK / OPK      = rotatable
        //
        // Before generating or publishing anything, we read what the SERVER
        // already knows about this device_id. If a public key is already
        // pinned server-side and our local material doesn't match, we MUST
        // NOT overwrite it — peers may be encrypting against the published
        // key right now. Instead we block and ask the user to restore.
        let devicePublicKeyB64: string | null = null;
        let serverDevicePublicKey: string | null = null;
        try {
          const { data: existing } = await supabase
            .from('user_devices')
            .select('device_public_key')
            .eq('user_id', user.id)
            .eq('device_id', deviceId)
            .maybeSingle();
          serverDevicePublicKey = (existing?.device_public_key as string | null) ?? null;
        } catch (lookupErr) {
          console.warn('[useDeviceRegistration] server device lookup failed:', lookupErr);
        }

        let localKx: Awaited<ReturnType<typeof getOrCreateDeviceKxKey>> | null = null;
        if (serverDevicePublicKey) {
          // Server already published a device key for this device_id.
          // ONLY load the local one — never auto-generate / overwrite.
          try {
            const { loadDeviceKxKey } = await import('@/lib/crypto/deviceKx');
            localKx = await loadDeviceKxKey(deviceId);
          } catch (loadErr) {
            console.warn('[useDeviceRegistration] loadDeviceKxKey failed:', loadErr);
          }

          if (!localKx) {
            const restored =
              (await restoreKeysFromKeychainSnapshot(user.id).catch(() => 'error')) === 'restored' ||
              (await restoreFromInMemoryMasterKey(user.id).catch(() => 'error')) === 'restored' ||
              (await restoreAccountKeysFromActiveSession(user.id).catch(() => 'error')) === 'restored';
            if (restored) {
              try {
                const { loadDeviceKxKey } = await import('@/lib/crypto/deviceKx');
                localKx = await loadDeviceKxKey(deviceId);
              } catch {}
            }
          }

          if (!localKx) {
            console.warn('[useDeviceRegistration] server device key exists but local material is still unavailable — waiting silently for restore');
            try {
              window.dispatchEvent(new CustomEvent('forsure:e2ee-silent-restore-retry', {
                detail: { source: 'device-registration', deviceId, reason: 'local-missing' },
              }));
            } catch {}
            ranRef.current = false; // allow retry once user has restored
            return;
          }

          if (localKx.publicB64 !== serverDevicePublicKey) {
            // Legacy migration window: the server may still hold the shared
            // identity key from the pre-per-device-kx era. In that case we
            // upgrade to the per-device kx and republish — that is allowed
            // because the previous entry was the shared key, not a device-
            // specific one. Anything else is a hard mismatch → BLOCK.
            const isLegacyShared = serverDevicePublicKey === bundle.identityKey;
            if (!isLegacyShared) {
              console.warn('[useDeviceRegistration] server/local device key mismatch — preserving server key and waiting silently for restore');
              try {
                window.dispatchEvent(new CustomEvent('forsure:e2ee-silent-restore-retry', {
                  detail: {
                    source: 'device-registration',
                    deviceId,
                    reason: 'mismatch',
                  },
                }));
              } catch {}
              ranRef.current = false;
              return;
            }
            console.log('[useDeviceRegistration] migrating legacy shared-identity device entry → per-device kx');
          }

          devicePublicKeyB64 = localKx.publicB64;
        } else {
          // First-time publish for this device_id → generation allowed.
          try {
            const kx = await getOrCreateDeviceKxKey(deviceId);
            if (kx?.publicB64) {
              devicePublicKeyB64 = kx.publicB64;
              localKx = kx;
            }
          } catch (kxErr) {
            console.warn('[useDeviceRegistration] device kx key generation failed, falling back to identityKey:', kxErr);
          }
          if (!devicePublicKeyB64) devicePublicKeyB64 = bundle.identityKey;
        }

        // Stable device fingerprint — lets the server-side
        // resolve_device_id_by_fingerprints RPC reuse this device_id after
        // Safari ITP wipes IndexedDB / localStorage / Keychain on iOS.
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

        // 1. Register the device (idempotent upsert)
        const { error: devErr } = await supabase
          .from('user_devices')
          .upsert(payload, { onConflict: 'user_id,device_id' });
        if (devErr) {
          console.warn('[useDeviceRegistration] device upsert failed:', devErr.message);
          return;
        }

        // Mark stale/revoke old devices and delete our local sessions to
        // devices that crossed the long inactivity threshold.
        try {
          const { data } = await (supabase as any).rpc("cleanup_stale_user_devices");
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
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
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
