/**
 * useDeviceRegistration — registers the current browser as an active device
 * for the logged-in user, and publishes a per-device Signed PreKey so that
 * other users can perform a targeted X3DH handshake against THIS device.
 *
 * Aegis multi-device model:
 *   - the account identity and signing keys are portable through Aegis Vault;
 *   - each physical device has its own KX key, prekeys and ratchet sessions;
 *   - peer sends remain fail-closed until the authenticated route is ready.
 */

import { useEffect, useRef } from 'react';
import { requireAuthenticatedDeviceSession } from '@/lib/device-manager/sessionGate';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  hydrateDeviceId,
  isDeviceIdTemporary,
  getDeviceFingerprint,
  rotateCurrentDeviceId,
} from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import {
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  peekDeviceSignedPrekey,
  isDevicePrekeyBundleError,
} from '@/lib/crypto/x3dh';
import { repairCurrentDevicePrekeys } from '@/lib/crypto/devicePrekeyRepair';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import {
  restoreAccountKeysFromActiveSession,
  restoreFromInMemoryMasterKey,
  restoreKeysFromKeychainSnapshot,
} from '@/lib/crypto/accountKeyBackup';

const REVOKED_DEVICE_ERROR_RE = /USER_DEVICES_REACTIVATION_BLOCKED|revoked_device_cannot_be_reactivated|DEVICE_REVOKED_OR_LOCKED|DEVICE_REVOKED(?!_OR_REJECTED)/i;
const DEVICE_APPROVAL_PENDING_RE = /DEVICE_APPROVAL_PENDING/i;
const DEVICE_REJECTED_RE = /DEVICE_REJECTED|DEVICE_REVOKED_OR_REJECTED/i;

type DeviceRegistrationRpcResult = {
  ok?: boolean;
  code?: string;
  message?: string;
};

export function useDeviceRegistration() {
  const { user } = useAuth();
  const ranRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let retryTimer: number | undefined;

    const approveCurrentAuthenticatedDevice = async (deviceId: string, source: string): Promise<boolean> => {
      try {
        const { data: approvalData, error } = await supabase.rpc('approve_user_device' as never, {
          p_device_id: deviceId,
        } as never);
        const data = approvalData as DeviceRegistrationRpcResult | null;
        if (!error && data?.ok === true) {
          console.info('[useDeviceRegistration] authenticated device approved', {
            deviceId: deviceId.slice(0, 8),
            source,
          });
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approved', {
              detail: { source, deviceId },
            }));
          } catch { /* browser event delivery is best-effort */ }
          return true;
        }
        console.warn('[useDeviceRegistration] approve_user_device non-ok', {
          deviceId: deviceId.slice(0, 8),
          source,
          error: error?.message,
          data,
        });
      } catch (approvalErr) {
        console.warn('[useDeviceRegistration] approve_user_device failed', approvalErr);
      }

      return false;
    };

    const scheduleRegistrationRetry = (reason: string, attempt: number) => {
      if (attempt >= 3) {
        console.warn('[useDeviceRegistration] automatic enrollment retry exhausted', {
          reason,
          attempt,
        });
        return;
      }
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      ranRef.current = false;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void registerCurrentDevice(`automatic-retry:${reason}`, attempt + 1);
      }, 500 * (attempt + 1));
    };

    const registerCurrentDevice = async (reason: string, attempt = 0) => {
      if (ranRef.current || inFlightRef.current) return;
      ranRef.current = true;
      inFlightRef.current = true;
      try {
        await requireAuthenticatedDeviceSession(user.id);
        console.log('[useDeviceRegistration] publishing current device', { reason, attempt });
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
            .select('device_public_key,is_active,revoked_at,approval_status')
            .eq('user_id', user.id)
            .eq('device_id', deviceId)
            .maybeSingle();

          const approvalStatus = existing?.approval_status;
          if (existing && approvalStatus === 'rejected') {
            console.warn('[useDeviceRegistration] rejected routing identity replaced after authenticated login', {
              deviceId: deviceId.slice(0, 8),
              attempt,
            });
            if (attempt < 2) {
              rotateCurrentDeviceId('authenticated-rejected-device');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-rejected-device', attempt + 1);
            }
            return;
          }
          if (existing && approvalStatus !== 'pending' && (existing.is_active === false || existing.revoked_at)) {
            console.warn('[useDeviceRegistration] server says current device id is revoked — rotating local id instead of reactivating', {
              deviceId: deviceId.slice(0, 8),
              attempt,
            });
            if (attempt < 2) {
              rotateCurrentDeviceId('server-revoked-before-publish');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-revoked-device', attempt + 1);
            }
            return;
          }

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
            localKx = await loadDeviceKxKey(deviceId, user.id);
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
                localKx = await loadDeviceKxKey(deviceId, user.id);
              } catch { /* the next enrollment attempt will retry restoration */ }
            }
          }

          if (!localKx) {
            // The account vault deliberately never clones physical-device
            // secrets. If this browser retained a DeviceID but lost its private
            // KX key, retire that logical identity and enroll a fresh device.
            if (attempt < 2) {
              rotateCurrentDeviceId('aegis-device-private-key-missing');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-after-device-key-loss', attempt + 1);
            }
            console.warn('[useDeviceRegistration] unable to enroll replacement device key');
            ranRef.current = false;
            return;
          }

          if (localKx.publicB64 !== serverDevicePublicKey) {
            console.warn('[useDeviceRegistration] server/local device key mismatch - waiting for restore');
            try {
              window.dispatchEvent(new CustomEvent('forsure:e2ee-silent-restore-retry', {
                detail: {
                  source: 'device-registration',
                  deviceId,
                  reason: 'mismatch',
                },
              }));
            } catch { /* browser event delivery is best-effort */ }
            ranRef.current = false;
            return;
          }

          devicePublicKeyB64 = localKx.publicB64;
        } else {
          // First-time publish for this device_id → generation allowed.
          try {
            const kx = await getOrCreateDeviceKxKey(deviceId, user.id);
            if (kx?.publicB64) {
              devicePublicKeyB64 = kx.publicB64;
              localKx = kx;
            }
          } catch (kxErr) {
            console.warn('[useDeviceRegistration] device kx key generation failed:', kxErr);
          }
          if (!devicePublicKeyB64) {
            ranRef.current = false;
            return;
          }
        }

        // Stable device fingerprint — lets the server-side
        // resolve_device_id_by_fingerprints RPC reuse this device_id after
        // Safari ITP wipes IndexedDB / localStorage / Keychain on iOS.
        const deviceFingerprint = await getDeviceFingerprint().catch(() => null);
        const latestDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
        if (latestDeviceId !== deviceId) {
          console.warn('[useDeviceRegistration] device id changed during restore - restarting publish with hydrated id', {
            previous: deviceId.slice(0, 8),
            next: latestDeviceId.slice(0, 8),
            reason,
            attempt,
          });
          ranRef.current = false;
          inFlightRef.current = false;
          if (attempt < 3) {
            return registerCurrentDevice('device-id-changed-during-restore', attempt + 1);
          }
          return;
        }

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

        // 1. Register the device.
        // The authenticated RPC is the only registration path. Direct upsert
        // fallback is forbidden because it would bypass device approval.
        let registered = false;
        try {
          const { data: rpcResult, error: rpcErr } = await supabase.rpc('register_user_device_safe', {
            p_user_id: payload.user_id,
            p_device_id: payload.device_id,
            p_device_name: payload.device_name,
            p_device_public_key: payload.device_public_key,
            p_device_fingerprint: payload.device_fingerprint,
            p_platform: payload.platform,
            p_user_agent: payload.user_agent,
          });
          const registrationResult = rpcResult as DeviceRegistrationRpcResult | null;

          if (!rpcErr && registrationResult?.ok === true) {
            registered = true;
          } else if (!rpcErr && DEVICE_APPROVAL_PENDING_RE.test(String(registrationResult?.code ?? registrationResult?.message ?? ''))) {
            const approved = await approveCurrentAuthenticatedDevice(deviceId, `register-pending:${reason}`);
            if (!approved) {
              scheduleRegistrationRetry(`approval:${reason}`, attempt);
              return;
            }
            registered = true;
          } else if (!rpcErr && REVOKED_DEVICE_ERROR_RE.test(String(registrationResult?.code ?? registrationResult?.message ?? ''))) {
            console.warn('[useDeviceRegistration] safe RPC rejected revoked device — rotating local id', registrationResult);
            if (attempt < 2) {
              rotateCurrentDeviceId('rpc-revoked-device');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-after-rpc-revoked', attempt + 1);
            }
            return;
          } else if (!rpcErr && DEVICE_REJECTED_RE.test(String(registrationResult?.code ?? registrationResult?.message ?? ''))) {
            if (attempt < 2) {
              rotateCurrentDeviceId('authenticated-rejected-device');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-after-rpc-rejected', attempt + 1);
            }
            return;
          } else if (rpcErr) {
            console.warn('[useDeviceRegistration] safe RPC unavailable/failed:', {
              message: rpcErr.message,
            });
          } else {
            console.warn('[useDeviceRegistration] safe RPC non-ok; device publish paused:', registrationResult);
            ranRef.current = false;
            return;
          }
        } catch (rpcUnexpectedErr) {
          console.warn('[useDeviceRegistration] safe RPC unexpected failure:', {
            error: rpcUnexpectedErr,
          });
        }

        if (!registered) {
          scheduleRegistrationRetry(`registration-rpc:${reason}`, attempt);
          return;
        }

        // 2. Ensure the per-device Signed PreKey exists and is fresh.
        //    This is what makes targeted X3DH per device possible. After the
        //    normal refresh, peek the SPK without consuming OPK. If it is still
        //    invalid/missing, run the repair helper: purge stale SPK/OPK state,
        //    publish a fresh SPK, and refill OPKs.
        try {
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
          const currentSpk = await peekDeviceSignedPrekey(user.id, deviceId);
          if (!currentSpk) {
            await repairCurrentDevicePrekeys(user.id, deviceId, keys.signingPrivateKey, 'current-device-spk-invalid-after-refresh');
            try { window.dispatchEvent(new CustomEvent('forsure-keys-restored', { detail: { source: 'device-prekey-repair', deviceId } })); } catch { /* best-effort */ }
            try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch { /* best-effort */ }
          }
        } catch (spkErr) {
          if (isDevicePrekeyBundleError(spkErr, 'DEVICE_SPK_SIGNATURE_INVALID')) {
            try {
              await repairCurrentDevicePrekeys(user.id, deviceId, keys.signingPrivateKey, 'current-device-spk-signature-invalid');
              try { window.dispatchEvent(new CustomEvent('forsure-keys-restored', { detail: { source: 'device-prekey-repair', deviceId } })); } catch { /* best-effort */ }
              try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch { /* best-effort */ }
            } catch (repairErr) {
              console.warn('[useDeviceRegistration] device SPK signature repair failed (non-fatal):', repairErr);
            }
          } else {
            console.warn('[useDeviceRegistration] device SPK refresh/repair failed (non-fatal):', spkErr);
          }
        }

        // 3. Refill the OPK pool if low (forward secrecy on bursts).
        //    Non-fatal: X3DH gracefully degrades to 3-DH when no OPK is available.
        try {
          await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
        } catch (opkErr) {
          console.warn('[useDeviceRegistration] OPK refill failed (non-fatal):', opkErr);
        }

        // Registration and prekeys are not enough for Aegis. Publish the
        // canonical account root, sign companions, then prove that this exact
        // DeviceID is visible through the fail-closed route used by senders.
        // Unhealthy companion devices stay visible for explicit user action;
        // registration never revokes or retires them automatically.
        const repairedCompanions = await ensureApprovedDeviceTrust(user.id, deviceId);
        invalidateAllFanoutRoutes();
        console.info('[useDeviceRegistration] authenticated E2EE device ready', {
          deviceId: deviceId.slice(0, 8),
          repairedCompanions,
        });
        void import('@/lib/crypto/accountKeyBackup').then((vault) => {
          void vault.syncKeychainSnapshotFromLocal(user.id);
          vault.requestBackgroundBackup('aegis-device-registration-ready');
        }).catch(() => undefined);
        try {
          window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approved', {
            detail: { source: `authenticated-registration:${reason}`, deviceId },
          }));
          window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
            detail: { reason: 'authenticated_device_ready', deviceId },
          }));
        } catch { /* browser event delivery is best-effort */ }
      } catch (err) {
        if (err instanceof PinUnlockRequiredError || String(err).toLowerCase().includes('pin unlock required')) {
          ranRef.current = false;
          console.warn('[useDeviceRegistration] PIN_REQUIRED — device publish paused until PIN unlock');
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', { detail: { source: 'useDeviceRegistration' } }));
          } catch { /* browser event delivery is best-effort */ }
          return;
        }
        ranRef.current = false;
        console.warn('[useDeviceRegistration] failed (non-fatal):', err);
        scheduleRegistrationRetry(`failure:${reason}`, attempt);
      } finally {
        inFlightRef.current = false;
      }
    };

    const onKeysAvailable = () => {
      ranRef.current = false;
      void registerCurrentDevice('keys-unlocked');
    };

    const onAuthenticatedDeviceEnroll = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; source?: string }>).detail;
      if (detail?.userId && detail.userId !== user.id) return;
      ranRef.current = false;
      void registerCurrentDevice(detail?.source ?? 'authenticated-device-enroll');
    };

    // A missing message copy is a message/refanout issue, not proof that the
    // local device is invalid. Once PIN/backup/key restore succeeded, the device
    // must stay valid unless a real key/SPK/mismatch error is detected.
    let lastSelfRepairAt = 0;
    const onSelfRepairRequired = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      const reason = String(detail?.reason ?? 'unknown');
      if (reason === 'absent-from-fanout') {
        console.info('[useDeviceRegistration] ignoring message-copy miss for device repair', {
          reason,
          messageId: detail?.messageId,
          peerUserId: detail?.peerUserId,
        });
        return;
      }

      const now = Date.now();
      if (now - lastSelfRepairAt < 15_000) return;
      lastSelfRepairAt = now;
      ranRef.current = false;
      void registerCurrentDevice(`self-repair:${reason}`);
    };

    void registerCurrentDevice('auth-mounted');
    window.addEventListener('forsure-keys-unlocked', onKeysAvailable);
    window.addEventListener('forsure-keys-restored', onKeysAvailable);
    window.addEventListener('forsure:authenticated-device-enroll', onAuthenticatedDeviceEnroll);
    window.addEventListener('forsure:device-self-repair-required', onSelfRepairRequired);

    return () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.removeEventListener('forsure-keys-unlocked', onKeysAvailable);
      window.removeEventListener('forsure-keys-restored', onKeysAvailable);
      window.removeEventListener('forsure:authenticated-device-enroll', onAuthenticatedDeviceEnroll);
      window.removeEventListener('forsure:device-self-repair-required', onSelfRepairRequired);
    };
  }, [user]);
}
