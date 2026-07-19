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
  rotateCurrentDeviceId,
} from '@/lib/messaging/currentDevice';
import { getOrCreateIdentityKeys, exportPublicKeyBundle, PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import {
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  refreshSignedPrekeyIfNeeded,
  peekDeviceSignedPrekey,
  isDevicePrekeyBundleError,
} from '@/lib/crypto/x3dh';
import { repairCurrentDevicePrekeys } from '@/lib/crypto/devicePrekeyRepair';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import {
  hasLocalKeys,
  restoreAccountKeysFromActiveSession,
  restoreFromInMemoryMasterKey,
  restoreKeysFromKeychainSnapshot,
} from '@/lib/crypto/accountKeyBackup';

const REVOKED_DEVICE_ERROR_RE = /USER_DEVICES_REACTIVATION_BLOCKED|revoked_device_cannot_be_reactivated|DEVICE_REVOKED_OR_LOCKED|DEVICE_REVOKED(?!_OR_REJECTED)/i;
const DEVICE_APPROVAL_PENDING_RE = /DEVICE_APPROVAL_PENDING/i;
const DEVICE_REJECTED_RE = /DEVICE_REJECTED|DEVICE_REVOKED_OR_REJECTED/i;

export function useDeviceRegistration() {
  const { user } = useAuth();
  const ranRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!user) return;

    const notifyDeviceApprovalPending = (deviceId: string, source: string, code = 'DEVICE_APPROVAL_PENDING') => {
      console.warn('[useDeviceRegistration] current device requires approval before E2EE publish', {
        deviceId: deviceId.slice(0, 8),
        source,
        code,
      });
      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approval-required', {
          detail: { source, deviceId, code },
        }));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
          detail: {
            source,
            deviceId,
            reason: 'device_approval_required',
            message: 'Déverrouillage requis pour approuver cet appareil',
          },
        }));
      } catch {}
    };

    const approveCurrentDeviceIfKeysUnlocked = async (deviceId: string, source: string): Promise<boolean> => {
      if (!(await hasLocalKeys().catch(() => false))) {
        notifyDeviceApprovalPending(deviceId, source);
        return false;
      }

      try {
        const { data, error } = await (supabase as any).rpc('approve_user_device', {
          p_device_id: deviceId,
        });
        if (!error && data?.ok === true) {
          console.info('[useDeviceRegistration] pending device approved after local key unlock', {
            deviceId: deviceId.slice(0, 8),
            source,
          });
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approved', {
              detail: { source, deviceId },
            }));
          } catch {}
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

      notifyDeviceApprovalPending(deviceId, source);
      return false;
    };

    const registerCurrentDevice = async (reason: string, attempt = 0) => {
      if (ranRef.current || inFlightRef.current) return;
      ranRef.current = true;
      inFlightRef.current = true;
      try {
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

          const approvalStatus = (existing as any)?.approval_status as string | null | undefined;
          if (existing && approvalStatus === 'rejected') {
            notifyDeviceApprovalPending(deviceId, `existing-rejected:${reason}`, 'DEVICE_REJECTED');
            ranRef.current = false;
            return;
          }
          if (existing && approvalStatus === 'pending') {
            const approved = await approveCurrentDeviceIfKeysUnlocked(deviceId, `existing-pending:${reason}`);
            if (!approved) {
              ranRef.current = false;
              return;
            }
          } else if (existing && (existing.is_active === false || existing.revoked_at)) {
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
            console.warn('[useDeviceRegistration] server device key exists but local material is still unavailable - waiting for restore');
            try {
              window.dispatchEvent(new CustomEvent('forsure:e2ee-silent-restore-retry', {
                detail: { source: 'device-registration', deviceId, reason: 'local-missing' },
              }));
            } catch {}
            try {
              window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
                detail: {
                  source: 'device-registration',
                  deviceId,
                  reason: 'registered_device_key_missing',
                  message: 'Deverrouillage requis pour restaurer cet appareil',
                },
              }));
            } catch {}
            ranRef.current = false;
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
              console.warn('[useDeviceRegistration] server/local device key mismatch - waiting for restore');
              try {
                window.dispatchEvent(new CustomEvent('forsure:e2ee-silent-restore-retry', {
                  detail: {
                    source: 'device-registration',
                    deviceId,
                    reason: 'mismatch',
                  },
                }));
              } catch {}
              try {
                window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
                  detail: {
                    source: 'device-registration',
                    deviceId,
                    reason: 'registered_device_key_mismatch',
                    message: 'Deverrouillage requis pour restaurer cet appareil',
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
        // Prefer the safe RPC added in the matching migration; fall back to the
        // legacy upsert while still detecting the revoked-device SQL error.
        let registered = false;
        let allowLegacyUpsert = false;
        try {
          const { data: rpcResult, error: rpcErr } = await (supabase as any).rpc('register_user_device_safe', {
            p_user_id: payload.user_id,
            p_device_id: payload.device_id,
            p_device_name: payload.device_name,
            p_device_public_key: payload.device_public_key,
            p_device_fingerprint: payload.device_fingerprint,
            p_platform: payload.platform,
            p_user_agent: payload.user_agent,
          });

          if (!rpcErr && rpcResult?.ok === true) {
            registered = true;
          } else if (!rpcErr && DEVICE_APPROVAL_PENDING_RE.test(String(rpcResult?.code ?? rpcResult?.message ?? ''))) {
            const approved = await approveCurrentDeviceIfKeysUnlocked(deviceId, `register-pending:${reason}`);
            if (!approved) {
              ranRef.current = false;
              return;
            }
            registered = true;
          } else if (!rpcErr && REVOKED_DEVICE_ERROR_RE.test(String(rpcResult?.code ?? rpcResult?.message ?? ''))) {
            console.warn('[useDeviceRegistration] safe RPC rejected revoked device — rotating local id', rpcResult);
            if (attempt < 2) {
              rotateCurrentDeviceId('rpc-revoked-device');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-after-rpc-revoked', attempt + 1);
            }
            return;
          } else if (!rpcErr && DEVICE_REJECTED_RE.test(String(rpcResult?.code ?? rpcResult?.message ?? ''))) {
            notifyDeviceApprovalPending(deviceId, `register-rejected:${reason}`, String(rpcResult?.code ?? 'DEVICE_REJECTED'));
            ranRef.current = false;
            return;
          } else if (rpcErr) {
            allowLegacyUpsert = !!serverDevicePublicKey;
            console.warn('[useDeviceRegistration] safe RPC unavailable/failed:', {
              message: rpcErr.message,
              legacyFallback: allowLegacyUpsert,
            });
          } else {
            console.warn('[useDeviceRegistration] safe RPC non-ok; device publish paused:', rpcResult);
            ranRef.current = false;
            return;
          }
        } catch (rpcUnexpectedErr) {
          allowLegacyUpsert = !!serverDevicePublicKey;
          console.warn('[useDeviceRegistration] safe RPC unexpected failure:', {
            error: rpcUnexpectedErr,
            legacyFallback: allowLegacyUpsert,
          });
        }

        if (!registered) {
          if (!allowLegacyUpsert) {
            notifyDeviceApprovalPending(deviceId, `register-rpc-unavailable:${reason}`, 'DEVICE_REGISTRATION_RPC_UNAVAILABLE');
            ranRef.current = false;
            return;
          }
          const { error: devErr } = await supabase
            .from('user_devices')
            .upsert(payload, { onConflict: 'user_id,device_id' });
          if (devErr) {
            console.warn('[useDeviceRegistration] device upsert failed:', devErr.message);
            if (REVOKED_DEVICE_ERROR_RE.test(devErr.message) && attempt < 2) {
              rotateCurrentDeviceId('upsert-revoked-device');
              ranRef.current = false;
              inFlightRef.current = false;
              return registerCurrentDevice('rotated-after-upsert-revoked', attempt + 1);
            }
            return;
          }
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
        //    This is what makes targeted X3DH per device possible. After the
        //    normal refresh, peek the SPK without consuming OPK. If it is still
        //    invalid/missing, run the repair helper: purge stale SPK/OPK state,
        //    publish a fresh SPK, and refill OPKs.
        try {
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
          const currentSpk = await peekDeviceSignedPrekey(user.id, deviceId);
          if (!currentSpk) {
            await repairCurrentDevicePrekeys(user.id, deviceId, keys.signingPrivateKey, 'current-device-spk-invalid-after-refresh');
            try { window.dispatchEvent(new CustomEvent('forsure-keys-restored', { detail: { source: 'device-prekey-repair', deviceId } })); } catch {}
            try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch {}
          }
        } catch (spkErr) {
          if (isDevicePrekeyBundleError(spkErr, 'DEVICE_SPK_SIGNATURE_INVALID')) {
            try {
              await repairCurrentDevicePrekeys(user.id, deviceId, keys.signingPrivateKey, 'current-device-spk-signature-invalid');
              try { window.dispatchEvent(new CustomEvent('forsure-keys-restored', { detail: { source: 'device-prekey-repair', deviceId } })); } catch {}
              try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch {}
            } catch (repairErr) {
              console.warn('[useDeviceRegistration] device SPK signature repair failed (non-fatal):', repairErr);
            }
          } else {
            console.warn('[useDeviceRegistration] device SPK refresh/repair failed (non-fatal):', spkErr);
          }
        }

        // 4. Refill the OPK pool if low (forward secrecy on bursts).
        //    Non-fatal: X3DH gracefully degrades to 3-DH when no OPK is available.
        try {
          await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
        } catch (opkErr) {
          console.warn('[useDeviceRegistration] OPK refill failed (non-fatal):', opkErr);
        }

        // 5. Self-heal a STALE PRIMARY. If THIS active device is published but
        //    NOT primary, and the current primary is one of MY OTHER devices
        //    that has NO active signed-prekey bundle (so it cannot receive any
        //    message and only blocks promotion of the real device), quarantine
        //    it. The DB trigger (ensure_primary_device_exists) then promotes
        //    THIS device, so peers can finally target it (fixes the cross-device
        //    "empty blue bubble"). A healthy secondary device (which always has
        //    a valid bundle) is never touched. Best-effort, non-fatal.
        try {
          const { data: myDevices } = await supabase
            .from('user_devices')
            .select('device_id, is_primary')
            .eq('user_id', user.id)
            .eq('is_active', true)
            .is('revoked_at', null);
          const meRow = (myDevices ?? []).find((d: any) => d.device_id === deviceId) as any;
          const stalePrimary = (myDevices ?? []).find((d: any) => d.is_primary && d.device_id !== deviceId) as any;
          if (meRow && !meRow.is_primary && stalePrimary) {
            const { data: spk } = await supabase
              .from('device_signed_prekeys')
              .select('spk_id')
              .eq('user_id', user.id)
              .eq('device_id', stalePrimary.device_id)
              .eq('is_active', true)
              .limit(1)
              .maybeSingle();
            if (!spk) {
              console.warn('[useDeviceRegistration] stale primary without bundle — quarantining so current device is promoted', {
                stalePrimary: String(stalePrimary.device_id).slice(0, 8),
                current: String(deviceId).slice(0, 8),
              });
              await (supabase as any).rpc('quarantine_own_invalid_device', {
                p_device_id: stalePrimary.device_id,
                p_reason: 'stale_primary_no_bundle_blocking_current_device',
              });
              try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch {}
            }
          }
        } catch (healErr) {
          console.warn('[useDeviceRegistration] stale-primary self-heal failed (non-fatal):', healErr);
        }

        // Registration and prekeys are not enough for Sesame-lite. Publish the
        // canonical account root, sign companions, then prove that this exact
        // DeviceID is visible through the fail-closed route used by senders.
        // This runs after stale-primary repair so the root binds the final
        // primary selected by the database.
        const repairedCompanions = await ensureApprovedDeviceTrust(user.id, deviceId);
        invalidateAllFanoutRoutes();
        console.info('[useDeviceRegistration] authenticated E2EE device ready', {
          deviceId: deviceId.slice(0, 8),
          repairedCompanions,
        });
        try {
          window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approved', {
            detail: { source: `authenticated-registration:${reason}`, deviceId },
          }));
          window.dispatchEvent(new CustomEvent('forsure:sesame-route-ready', {
            detail: { reason: 'authenticated_device_ready', deviceId },
          }));
        } catch {}
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
    window.addEventListener('forsure:device-self-repair-required', onSelfRepairRequired);

    return () => {
      window.removeEventListener('forsure-keys-unlocked', onKeysAvailable);
      window.removeEventListener('forsure-keys-restored', onKeysAvailable);
      window.removeEventListener('forsure:device-self-repair-required', onSelfRepairRequired);
    };
  }, [user]);
}
