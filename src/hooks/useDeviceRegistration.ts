/**
 * Registers the current installation through the server-assigned Aegis flow.
 * New devices are staged as pending and can only be approved by another active,
 * approved device. Device prekeys and routing become available after approval.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { requireAuthenticatedDeviceSession } from '@/lib/device-manager/sessionGate';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  getDeviceFingerprint,
  hydrateDeviceId,
  rotateCurrentDeviceId,
  setCurrentDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';
import {
  deleteRawIdentityKeys,
  loadIdentityKeys,
  PinUnlockRequiredError,
} from '@/lib/crypto/keyManager';
import { startKeyConsistencyGuard } from '@/lib/crypto/keyConsistencyGuard';
import {
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  peekDeviceSignedPrekey,
  isDevicePrekeyBundleError,
} from '@/lib/crypto/x3dh';
import { repairCurrentDevicePrekeys } from '@/lib/crypto/devicePrekeyRepair';
import {
  deleteDeviceKxKey,
  getOrCreateDeviceKxKey,
  loadDeviceKxKey,
  type DeviceKxKey,
} from '@/lib/crypto/deviceKx';
import {
  deleteDeviceIdentity,
  getOrCreateDeviceIdentity,
  loadDeviceIdentity,
  prepareDeviceAuthorization,
  type DeviceIdentityKey,
} from '@/lib/crypto/deviceIdentity';
import {
  beginServerAssignedDeviceEnrollment,
  cancelServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
  type DeviceEnrollmentChallenge,
  type DevicePlatform,
} from '@/lib/crypto/serverDeviceEnrollment';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { beginAccountSynchronization } from '@/lib/messaging/accountSyncBarrier';
import { syncAegisDeviceInbox } from '@/lib/messaging/aegisDeviceInbox';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { invalidateAegisDeviceRuntime } from '@/lib/messaging/aegisDeviceRuntime';
import {
  restoreAccountKeysFromActiveSession,
  restoreFromInMemoryMasterKey,
  restoreKeysFromKeychainSnapshot,
} from '@/lib/crypto/accountKeyBackup';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const MAX_ENROLLMENT_ATTEMPTS = 3;
const APPROVAL_POLL_MS = 8_000;

type ExistingDeviceRow = {
  device_id: string;
  device_public_key: string | null;
  device_signing_key: string | null;
  device_authorization_signature: string | null;
  device_fingerprint: string | null;
  platform: string | null;
  is_active: boolean | null;
  approval_status: string | null;
  revoked_at: string | null;
  crypto_invalid_at: string | null;
  routing_status: string | null;
};

function normalizePlatform(value: unknown): DevicePlatform {
  const platform = String(value ?? '').toLowerCase();
  if (platform === 'ios' || platform === 'android') return platform;
  return 'web';
}

function isApproved(row: ExistingDeviceRow): boolean {
  return String(row.approval_status ?? 'approved').toLowerCase() === 'approved';
}

function isPending(row: ExistingDeviceRow): boolean {
  return String(row.approval_status ?? '').toLowerCase() === 'pending';
}

async function readDevice(userId: string, deviceId: string): Promise<ExistingDeviceRow | null> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,device_public_key,device_signing_key,device_authorization_signature,device_fingerprint,platform,is_active,approval_status,revoked_at,crypto_invalid_at,routing_status')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw new Error(`DEVICE_ROUTE_LOOKUP_FAILED:${error.message}`);
  return (data as ExistingDeviceRow | null) ?? null;
}

async function findRecoverablePendingDevice(
  userId: string,
  fingerprint: string,
  platform: DevicePlatform,
): Promise<ExistingDeviceRow | null> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,device_public_key,device_signing_key,device_authorization_signature,device_fingerprint,platform,is_active,approval_status,revoked_at,crypto_invalid_at,routing_status')
    .eq('user_id', userId)
    .eq('device_fingerprint', fingerprint)
    .eq('platform', platform)
    .eq('approval_status', 'pending')
    .is('revoked_at', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`DEVICE_PENDING_LOOKUP_FAILED:${error.message}`);
  const candidate = (data as ExistingDeviceRow | null) ?? null;
  if (!candidate || !SERVER_DEVICE_ID_RE.test(candidate.device_id)) return null;

  const [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, candidate.device_id).catch(() => null),
    loadDeviceKxKey(candidate.device_id, userId).catch(() => null),
  ]);
  return identity && kx ? candidate : null;
}

async function markRouteUnavailable(deviceId: string, code: string): Promise<void> {
  await supabase.rpc('mark_current_device_route_unavailable' as never, {
    p_device_id: deviceId,
    p_error_code: code,
  } as never).then(() => undefined, () => undefined);
}

async function restoreDeviceMaterial(userId: string): Promise<void> {
  const restoredFromKeychain = await restoreKeysFromKeychainSnapshot(userId).catch(() => 'error');
  if (restoredFromKeychain === 'restored') return;
  const restoredFromMemory = await restoreFromInMemoryMasterKey(userId).catch(() => 'error');
  if (restoredFromMemory === 'restored') return;
  await restoreAccountKeysFromActiveSession(userId).catch(() => 'error');
}

/**
 * A second device must reuse the account identity already published by the
 * first device. A mismatched local identity is deleted only when a portable
 * account backup exists, then restored from the unlocked account vault.
 */
async function ensureCanonicalAccountIdentity(userId: string): Promise<void> {
  const { data: serverIdentity, error: serverError } = await supabase
    .from('user_public_keys')
    .select('fingerprint')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (serverError) throw new Error(`ACCOUNT_IDENTITY_LOOKUP_FAILED:${serverError.message}`);
  const expectedFingerprint = serverIdentity?.fingerprint;
  if (!expectedFingerprint) return;

  let local = await loadIdentityKeys(userId).catch(() => null);
  if (local?.fingerprint === expectedFingerprint) return;

  const { data: backup, error: backupError } = await supabase
    .from('user_backups' as any)
    .select('id')
    .eq('user_id', userId)
    .eq('backup_type', 'account')
    .maybeSingle();
  if (backupError) throw new Error(`ACCOUNT_BACKUP_LOOKUP_FAILED:${backupError.message}`);
  if (!backup) {
    throw new PinUnlockRequiredError(
      'PIN_UNLOCK_REQUIRED: canonical account identity backup is unavailable on this device.',
    );
  }

  if (local && local.fingerprint !== expectedFingerprint) {
    await deleteRawIdentityKeys(userId);
  }

  await restoreDeviceMaterial(userId);
  local = await loadIdentityKeys(userId).catch(() => null);
  if (!local || local.fingerprint !== expectedFingerprint) {
    try {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
        detail: {
          userId,
          reason: 'account_identity_mismatch',
          source: 'useDeviceRegistration',
          expectedFingerprint,
          actualFingerprint: local?.fingerprint ?? null,
        },
      }));
    } catch {
      // Browser notification is best-effort.
    }
    throw new PinUnlockRequiredError(
      'PIN_UNLOCK_REQUIRED: restore the existing account identity before enrolling this device.',
    );
  }
}

function dispatchPendingDevice(deviceId: string): void {
  window.dispatchEvent(new CustomEvent('forsure:e2ee-device-pending', {
    detail: { deviceId, status: 'pending' },
  }));
}

export function useDeviceRegistration() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const ranRef = useRef(false);
  const inFlightRef = useRef(false);
  const [localDeviceFingerprint, setLocalDeviceFingerprint] = useState<string | null>(null);

  // Empreinte locale du device courant: elle permet à l'appareil en attente
  // d'afficher exactement la même valeur que l'approbateur avant la décision.
  useEffect(() => {
    if (!user?.id) {
      setLocalDeviceFingerprint(null);
      return;
    }
    let cancelled = false;

    const compute = async () => {
      try {
        const deviceId = await hydrateDeviceId();
        if (!deviceId || isDeviceIdTemporary()) return;
        const [identity, kx] = await Promise.all([
          loadDeviceIdentity(user.id, deviceId),
          loadDeviceKxKey(deviceId, user.id),
        ]);
        if (cancelled || !identity?.publicB64 || !kx?.publicB64) return;
        const fingerprint = await computeDeviceApprovalFingerprint({
          deviceId,
          devicePublicKey: kx.publicB64,
          deviceSigningKey: identity.publicB64,
        });
        if (!cancelled) setLocalDeviceFingerprint(fingerprint);
      } catch {
        // L'empreinte est un confort de vérification, jamais un bloqueur.
      }
    };

    void compute();
    const onDeviceEvent = () => { void compute(); };
    window.addEventListener('forsure:e2ee-device-pending', onDeviceEvent);
    window.addEventListener('forsure:e2ee-device-approved', onDeviceEvent);
    return () => {
      cancelled = true;
      window.removeEventListener('forsure:e2ee-device-pending', onDeviceEvent);
      window.removeEventListener('forsure:e2ee-device-approved', onDeviceEvent);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    setCurrentDeviceUserScope(user.id);

    let retryTimer: number | undefined;
    let approvalPoll: number | undefined;
    let disposed = false;

    const scheduleRetry = (reason: string, attempt: number) => {
      if (disposed || attempt >= MAX_ENROLLMENT_ATTEMPTS) {
        console.warn('[useDeviceRegistration] automatic enrollment retry exhausted', { reason, attempt });
        return;
      }
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      ranRef.current = false;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void registerCurrentDevice(`automatic-retry:${reason}`, attempt + 1);
      }, 500 * (attempt + 1));
    };

    const registerCurrentDevice = async (reason: string, attempt = 0): Promise<void> => {
      if (disposed || ranRef.current || inFlightRef.current) return;
      ranRef.current = true;
      inFlightRef.current = true;

      const startedAt = Date.now();
      let tracedDeviceId: string | undefined;
      let challenge: DeviceEnrollmentChallenge | null = null;
      let provisionalDeviceId: string | null = null;

      const trace = (
        stage: string,
        details: Partial<Parameters<typeof traceE2EE>[0]> = {},
        level: 'info' | 'warn' | 'error' = 'info',
      ) => traceE2EE({
        direction: 'device',
        stage,
        deviceId: tracedDeviceId,
        elapsedMs: Date.now() - startedAt,
        retryCount: attempt,
        ...details,
      }, level);

      const restartWithFreshServerDevice = async (restartReason: string): Promise<void> => {
        rotateCurrentDeviceId(restartReason);
        invalidateAegisDeviceRuntime(user.id);
        ranRef.current = false;
        inFlightRef.current = false;
        if (attempt < MAX_ENROLLMENT_ATTEMPTS - 1) {
          await registerCurrentDevice(`fresh-device:${restartReason}`, attempt + 1);
        }
      };

      trace('DEVICE_REGISTRATION_START');

      try {
        await requireAuthenticatedDeviceSession(user.id);

        const platform = normalizePlatform(getCurrentPlatform());
        const fingerprint = await getDeviceFingerprint();
        let deviceId = await hydrateDeviceId();
        let existing = await readDevice(user.id, deviceId);

        if (!existing) {
          const pending = await findRecoverablePendingDevice(user.id, fingerprint, platform);
          if (pending) {
            deviceId = setCurrentDeviceId(pending.device_id);
            existing = pending;
            trace('DEVICE_PENDING_RECOVERED');
          }
        }

        if (existing && normalizePlatform(existing.platform) !== platform) {
          await markRouteUnavailable(existing.device_id, 'CROSS_PLATFORM_DEVICE_ID');
          await restartWithFreshServerDevice('cross-platform-device-id');
          return;
        }

        if (existing && (existing.revoked_at || existing.approval_status === 'rejected')) {
          window.dispatchEvent(new CustomEvent('forsure:current-device-revoked', {
            detail: { deviceId: existing.device_id, status: existing.approval_status ?? 'revoked' },
          }));
          return;
        }

        if (existing && isApproved(existing) && existing.is_active !== true) {
          await markRouteUnavailable(existing.device_id, 'APPROVED_DEVICE_INACTIVE');
          window.dispatchEvent(new CustomEvent('forsure:current-device-revoked', {
            detail: { deviceId: existing.device_id, status: 'inactive' },
          }));
          return;
        }

        if (!existing || isPending(existing)) {
          await ensureCanonicalAccountIdentity(user.id);
        }

        if (!existing) {
          challenge = await beginServerAssignedDeviceEnrollment({
            deviceName: getCurrentDeviceLabel(),
            deviceFingerprint: fingerprint,
            platform,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
          });
          deviceId = setCurrentDeviceId(challenge.deviceId);
          provisionalDeviceId = deviceId;
          trace('DEVICE_SERVER_ID_ASSIGNED');
        }

        tracedDeviceId = deviceId;

        let deviceIdentity: DeviceIdentityKey | null;
        let deviceKx: DeviceKxKey | null;

        if (existing) {
          [deviceIdentity, deviceKx] = await Promise.all([
            loadDeviceIdentity(user.id, deviceId),
            loadDeviceKxKey(deviceId, user.id),
          ]);

          if (!deviceIdentity || !deviceKx) {
            await restoreDeviceMaterial(user.id);
            [deviceIdentity, deviceKx] = await Promise.all([
              loadDeviceIdentity(user.id, deviceId),
              loadDeviceKxKey(deviceId, user.id),
            ]);
          }

          if (!deviceIdentity || !deviceKx) {
            await markRouteUnavailable(deviceId, 'LOCAL_DEVICE_PRIVATE_KEY_MISSING');
            await restartWithFreshServerDevice('device-private-key-missing');
            return;
          }

          if (
            !existing.device_public_key ||
            !existing.device_signing_key ||
            !existing.device_authorization_signature
          ) {
            await markRouteUnavailable(deviceId, 'DEVICE_AUTHORIZATION_INCOMPLETE');
            await restartWithFreshServerDevice('device-authorization-incomplete');
            return;
          }

          if (
            deviceKx.publicB64 !== existing.device_public_key ||
            deviceIdentity.publicB64 !== existing.device_signing_key
          ) {
            await markRouteUnavailable(deviceId, 'LOCAL_DEVICE_KEY_MISMATCH');
            await restartWithFreshServerDevice('device-key-mismatch');
            return;
          }
        } else {
          [deviceIdentity, deviceKx] = await Promise.all([
            getOrCreateDeviceIdentity(user.id, deviceId),
            getOrCreateDeviceKxKey(deviceId, user.id),
          ]);
        }

        trace('DEVICE_LOCAL_KEYS_READY');

        const authorization = await prepareDeviceAuthorization(user.id, deviceId, deviceKx);
        if (
          authorization.deviceSigning.publicB64 !== deviceIdentity.publicB64 ||
          authorization.deviceKx.publicB64 !== deviceKx.publicB64
        ) {
          throw new Error('DEVICE_AUTHORIZATION_LOCAL_KEY_MISMATCH');
        }

        if (existing && existing.device_authorization_signature !== authorization.authorizationSignature) {
          await markRouteUnavailable(deviceId, 'ACCOUNT_DEVICE_AUTHORIZATION_CHANGED');
          await restartWithFreshServerDevice('account-device-authorization-changed');
          return;
        }

        if (challenge) {
          const stagedDeviceId = await completeServerAssignedDeviceEnrollment(challenge, authorization);
          if (stagedDeviceId !== deviceId) throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
          challenge = null;
          provisionalDeviceId = null;
          trace('DEVICE_ENROLLMENT_PENDING');
          dispatchPendingDevice(deviceId);
          return;
        }

        if (existing && isPending(existing)) {
          trace('DEVICE_APPROVAL_WAITING');
          dispatchPendingDevice(deviceId);
          return;
        }

        if (!existing || !isApproved(existing)) {
          throw new Error('DEVICE_APPROVAL_STATE_INVALID');
        }

        const signingPrivateKey = deviceIdentity.privateKey;

        try {
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, signingPrivateKey);
          const currentSpk = await peekDeviceSignedPrekey(user.id, deviceId);
          if (!currentSpk) {
            await repairCurrentDevicePrekeys(
              user.id,
              deviceId,
              signingPrivateKey,
              'current-device-spk-invalid-after-refresh',
            );
            window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
              detail: { source: 'device-prekey-repair', deviceId },
            }));
            window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
          }
          trace('DEVICE_SPK_READY');
        } catch (spkError) {
          if (!isDevicePrekeyBundleError(spkError, 'DEVICE_SPK_SIGNATURE_INVALID')) throw spkError;
          await repairCurrentDevicePrekeys(
            user.id,
            deviceId,
            signingPrivateKey,
            'current-device-spk-signature-invalid',
          );
          trace('DEVICE_SPK_REPAIRED');
        }

        await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId).catch((error) => {
          console.warn('[useDeviceRegistration] OPK refill failed; 3-DH fallback remains available', error);
        });
        trace('DEVICE_OPK_POOL_READY');

        const { data: routeData, error: routeError } = await supabase.rpc(
          'mark_current_device_route_ready' as never,
          { p_device_id: deviceId } as never,
        );
        const route = routeData as { ok?: boolean; code?: string } | null;
        if (routeError || route?.ok !== true) {
          throw new Error(`DEVICE_ROUTE_NOT_READY:${route?.code ?? routeError?.message ?? 'UNKNOWN'}`);
        }

        invalidateAllFanoutRoutes();
        invalidateAegisDeviceRuntime(user.id);
        await ensureApprovedDeviceTrust(user.id, deviceId);

        trace('ACCOUNT_SYNC_START');
        await beginAccountSynchronization(user.id, async () => {
          await syncAegisDeviceInbox(user.id);
          await queryClient.invalidateQueries({ refetchType: 'none' });
          await queryClient.refetchQueries({ type: 'active' });
          window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
            detail: { reason: 'approved-device-account-sync', deviceId },
          }));
          window.dispatchEvent(new CustomEvent('forsure:account-sync-complete', {
            detail: { userId: user.id, deviceId },
          }));
        });
        trace('ACCOUNT_SYNC_READY');
        trace('DEVICE_READY');

        void import('@/lib/crypto/accountKeyBackup').then((vault) => {
          void vault.syncKeychainSnapshotFromLocal(user.id);
          vault.requestBackgroundBackup('aegis-device-registration-ready');
        }).catch(() => undefined);

        window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approved', {
          detail: { source: `trusted-device-registration:${reason}`, deviceId },
        }));
        window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
          detail: { reason: 'trusted_device_ready', deviceId },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace('DEVICE_REGISTRATION_FAILED', { errorCode: message.slice(0, 120) }, 'error');

        if (challenge) {
          try {
            const settlement = await cancelServerAssignedDeviceEnrollment(
              challenge,
              message.slice(0, 120),
            );
            if (settlement.status === 'cancelled' && provisionalDeviceId) {
              await Promise.allSettled([
                deleteDeviceIdentity(user.id, provisionalDeviceId),
                deleteDeviceKxKey(provisionalDeviceId, user.id),
              ]);
              rotateCurrentDeviceId('cancelled-server-enrollment');
            }
          } catch (settlementError) {
            console.warn('[useDeviceRegistration] enrollment settlement unavailable; provisional keys preserved', settlementError);
          }
        }

        if (
          error instanceof PinUnlockRequiredError
          || message.toLowerCase().includes('pin unlock required')
          || message.includes('ACCOUNT_KEY_RESTORE_REQUIRED')
        ) {
          ranRef.current = false;
          window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
            detail: { source: 'useDeviceRegistration' },
          }));
          return;
        }

        if (
          /DEVICE_IDENTITY_UNVERIFIED|DEVICE_ROUTE_NOT_AUTHORIZED|E2EE_SENDER_DEVICE_NOT_TRUSTED/.test(message)
          && attempt < MAX_ENROLLMENT_ATTEMPTS - 1
        ) {
          const failedDeviceId = tracedDeviceId ?? getCurrentDeviceId();
          await markRouteUnavailable(failedDeviceId, 'VERIFIED_ROUTE_CHECK_FAILED');
          await restartWithFreshServerDevice('verified-route-check-failed');
          return;
        }

        ranRef.current = false;
        console.warn('[useDeviceRegistration] registration deferred', error);
        scheduleRetry(`failure:${reason}`, attempt);
      } finally {
        inFlightRef.current = false;
      }
    };

    const triggerRegistration = (source: string) => {
      ranRef.current = false;
      invalidateAegisDeviceRuntime(user.id);
      void registerCurrentDevice(source);
    };

    const inspectCurrentDecision = async (source: string) => {
      const currentDeviceId = getCurrentDeviceId();
      if (!SERVER_DEVICE_ID_RE.test(currentDeviceId)) return;
      const row = await readDevice(user.id, currentDeviceId).catch(() => null);
      if (!row) return;
      if (isApproved(row) && row.is_active === true) {
        triggerRegistration(source);
        return;
      }
      if (row.revoked_at || row.approval_status === 'rejected') {
        window.dispatchEvent(new CustomEvent('forsure:current-device-revoked', {
          detail: { deviceId: row.device_id, status: row.approval_status ?? 'revoked' },
        }));
      }
    };

    const onKeysAvailable = () => triggerRegistration('keys-available');
    const onAuthenticatedDeviceEnroll = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; source?: string }>).detail;
      if (detail?.userId && detail.userId !== user.id) return;
      triggerRegistration(detail?.source ?? 'authenticated-device-enroll');
    };

    let lastSelfRepairAt = 0;
    const onSelfRepairRequired = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail;
      const reason = String(detail?.reason ?? 'unknown');
      if (reason === 'absent-from-fanout') return;
      const now = Date.now();
      if (now - lastSelfRepairAt < 15_000) return;
      lastSelfRepairAt = now;
      triggerRegistration(`self-repair:${reason}`);
    };

    const approvalChannel = supabase
      .channel(`device-approval:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_devices',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as Partial<ExistingDeviceRow>;
          if (row.device_id !== getCurrentDeviceId()) return;
          void inspectCurrentDecision('approval-realtime');
        },
      )
      .subscribe();

    approvalPoll = window.setInterval(() => {
      void inspectCurrentDecision('approval-poll');
    }, APPROVAL_POLL_MS);

    void registerCurrentDevice('auth-mounted');
    const stopKeyGuard = startKeyConsistencyGuard();
    window.addEventListener('forsure-keys-unlocked', onKeysAvailable);
    window.addEventListener('forsure-keys-restored', onKeysAvailable);
    window.addEventListener('forsure:authenticated-device-enroll', onAuthenticatedDeviceEnroll);
    window.addEventListener('forsure:device-self-repair-required', onSelfRepairRequired);

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (approvalPoll !== undefined) window.clearInterval(approvalPoll);
      void supabase.removeChannel(approvalChannel);
      stopKeyGuard();
      window.removeEventListener('forsure-keys-unlocked', onKeysAvailable);
      window.removeEventListener('forsure-keys-restored', onKeysAvailable);
      window.removeEventListener('forsure:authenticated-device-enroll', onAuthenticatedDeviceEnroll);
      window.removeEventListener('forsure:device-self-repair-required', onSelfRepairRequired);
    };
  }, [queryClient, user]);

  return { localDeviceFingerprint };
}
