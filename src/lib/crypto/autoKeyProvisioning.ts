import { supabase } from '@/integrations/supabase/client';
import {
  exportPublicKeyBundle,
  fetchServerIdentityState,
  getOrCreateIdentityKeys,
  hasRawIdentityKeys,
  identityBundleMatchesServer,
} from '@/lib/crypto/keyManager';
import {
  hasLocalKeys,
  restoreAccountKeysFromActiveSession,
  restoreKeysFromKeychainSnapshot,
  syncAvailableBackupsToServer,
  syncKeychainSnapshotFromLocal,
} from '@/lib/crypto/accountKeyBackup';
import {
  refillDeviceOneTimePrekeysIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
  refreshSignedPrekeyIfNeeded,
} from '@/lib/crypto/x3dh';
import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import {
  getCurrentDeviceId,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  hydrateDeviceId,
  isDeviceIdTemporary,
} from '@/lib/messaging/currentDevice';

export type AutoKeyProvisionStatus =
  | 'ready'
  | 'first_setup_required'
  | 'restore_required'
  | 'pin_required'
  | 'blocked'
  | 'temporary_device'
  | 'error';

export interface AutoKeyProvisionResult {
  status: AutoKeyProvisionStatus;
  reason: string;
  deviceId?: string;
  fingerprint?: string;
}

export interface AutoKeyProvisionOptions {
  reason?: string;
  force?: boolean;
}

const inflight = new Map<string, Promise<AutoKeyProvisionResult>>();
const lastReadyAt = new Map<string, number>();
const READY_TTL_MS = 60_000;

function result(status: AutoKeyProvisionStatus, reason: string, extra: Partial<AutoKeyProvisionResult> = {}): AutoKeyProvisionResult {
  return { status, reason, ...extra };
}

function emitProvisioned(detail: AutoKeyProvisionResult & { userId: string }) {
  try {
    window.dispatchEvent(new CustomEvent('forsure:device-kx-ready', { detail }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  } catch {
    /* SSR safe */
  }
}

function emitRestoreNeeded(userId: string, reason: string) {
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
      detail: { userId, reason, source: 'auto_key_provisioning' },
    }));
  } catch {
    /* SSR safe */
  }
}

async function restoreLocalIdentityIfPossible(userId: string): Promise<'ok' | 'pin_required' | 'unavailable' | 'error'> {
  if (await hasRawIdentityKeys(userId)) return 'ok';

  const keychain = await restoreKeysFromKeychainSnapshot(userId);
  if (keychain === 'restored' && await hasRawIdentityKeys(userId)) return 'ok';
  if (keychain === 'error') return 'error';

  const activeSession = await restoreAccountKeysFromActiveSession(userId);
  if ((activeSession === 'restored' || activeSession === 'local_ok') && await hasRawIdentityKeys(userId)) {
    return 'ok';
  }
  if (activeSession === 'error') return 'error';

  if (await hasLocalKeys()) return 'pin_required';
  return 'unavailable';
}

async function doProvision(userId: string, options: AutoKeyProvisionOptions = {}): Promise<AutoKeyProvisionResult> {
  const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
  if (isDeviceIdTemporary()) {
    return result('temporary_device', 'device_id_temporary', { deviceId });
  }

  const serverIdentity = await fetchServerIdentityState(userId);
  const restoreStatus = await restoreLocalIdentityIfPossible(userId);

  if (restoreStatus === 'error') {
    return result('error', 'identity_restore_error', { deviceId });
  }

  if (!serverIdentity && restoreStatus === 'unavailable') {
    return result('first_setup_required', 'server_identity_missing', { deviceId });
  }

  if (serverIdentity && restoreStatus === 'unavailable') {
    emitRestoreNeeded(userId, 'server_identity_exists_local_missing');
    return result('restore_required', 'server_identity_exists_local_missing', { deviceId });
  }

  if (restoreStatus === 'pin_required') {
    return result('pin_required', 'local_identity_locked', { deviceId, fingerprint: serverIdentity?.fingerprint });
  }

  const keys = await getOrCreateIdentityKeys(userId, {
    allowCreate: !serverIdentity,
  });
  const bundle = await exportPublicKeyBundle(keys);

  if (serverIdentity && !identityBundleMatchesServer(bundle, serverIdentity)) {
    logCryptoError({
      severity: 'critical',
      context: 'restore',
      errorCode: 'E_DEVICE_PROVISION_IDENTITY_MISMATCH',
      errorMessage: 'Local identity does not match server identity; blocking device provisioning',
      metadata: { userId, reason: options.reason },
    });
    return result('blocked', 'identity_fingerprint_mismatch', {
      deviceId,
      fingerprint: serverIdentity.fingerprint,
    });
  }

  if (!serverIdentity) {
    const { error } = await supabase
      .from('user_public_keys')
      .upsert({
        user_id: userId,
        identity_key: bundle.identityKey,
        signing_key: bundle.signingKey,
        fingerprint: bundle.fingerprint,
        is_active: true,
      }, { onConflict: 'user_id' });
    if (error) throw error;
  }

  const kx = await getOrCreateDeviceKxKey(deviceId);
  const { error: deviceError } = await supabase
    .from('user_devices')
    .upsert({
      user_id: userId,
      device_id: deviceId,
      device_name: getCurrentDeviceLabel(),
      device_public_key: kx.publicB64,
      platform: getCurrentPlatform(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
      is_active: true,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id,device_id' });
  if (deviceError) throw deviceError;

  await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
  await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, keys.signingPrivateKey);
  await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);
  await syncKeychainSnapshotFromLocal(userId).catch(() => false);
  await syncAvailableBackupsToServer(userId).catch(() => false);

  const ready = result('ready', 'device_crypto_provisioned', {
    deviceId,
    fingerprint: bundle.fingerprint,
  });
  emitProvisioned({ ...ready, userId });
  logCryptoError({
    severity: 'info',
    context: 'key.rotate',
    errorCode: 'DEVICE_KX_PROVISIONED',
    errorMessage: 'Device key exchange material and prekeys are provisioned',
    myDeviceId: deviceId,
    metadata: { userId, reason: options.reason, force: !!options.force },
  });
  return ready;
}

export function resetAutoKeyProvisioningCache(userId?: string) {
  if (userId) {
    inflight.delete(userId);
    lastReadyAt.delete(userId);
    return;
  }
  inflight.clear();
  lastReadyAt.clear();
}

export function ensureAutoKeyProvisioning(
  userId: string,
  options: AutoKeyProvisionOptions = {},
): Promise<AutoKeyProvisionResult> {
  const now = Date.now();
  const last = lastReadyAt.get(userId) || 0;
  if (!options.force && now - last < READY_TTL_MS) {
    return Promise.resolve(result('ready', 'recently_provisioned'));
  }

  const existing = inflight.get(userId);
  if (existing) return existing;

  const promise = doProvision(userId, options)
    .then((res) => {
      if (res.status === 'ready') lastReadyAt.set(userId, Date.now());
      return res;
    })
    .catch((err) => {
      logCryptoException('key.rotate', err, {
        severity: 'error',
        metadata: { userId, reason: options.reason, force: !!options.force },
      });
      return result('error', err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      inflight.delete(userId);
    });

  inflight.set(userId, promise);
  return promise;
}
