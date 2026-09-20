import { deviceApi, type DeviceApiSnapshot } from '@/lib/api/deviceApi';
import { readPinUnlocked } from '@/lib/device-manager/pinUnlockSignal';
import { hasLibsignalStore } from '@/lib/crypto/libsignalPlatformBridge';
import { traceCurrentDeviceFinalization } from '@/lib/device-manager/deviceFinalizationTrace';

export type CryptoApiState =
  | 'locked'
  | 'device_unregistered'
  | 'device_pending_approval'
  | 'account_binding_required'
  | 'device_key_setup_required'
  | 'ready'
  | 'revoked';

export interface CryptoApiSnapshot {
  state: CryptoApiState;
  device: DeviceApiSnapshot;
}

function stateFromDevice(userId: string, device: DeviceApiSnapshot): CryptoApiState {
  if (!readPinUnlocked(userId)) return 'locked';
  switch (device.state) {
    case 'unregistered': return 'device_unregistered';
    case 'pending_approval': return 'device_pending_approval';
    case 'binding_required': return 'account_binding_required';
    case 'key_setup_required': return 'device_key_setup_required';
    case 'revoked': return 'revoked';
    case 'ready': return 'ready';
  }
}

async function getState(userId: string): Promise<CryptoApiSnapshot> {
  const device = await deviceApi.getState(userId);
  return { state: stateFromDevice(userId, device), device };
}

function routeCanBeFinalized(device: DeviceApiSnapshot): boolean {
  const record = device.record;
  return Boolean(record
    && !record.revokedAt
    && record.approvalStatus === 'approved'
    && record.bindingStatus === 'bound'
    && record.routingStatus === 'ready'
    && record.isActive
    && (record.lifecycleStatus === 'approved'
      || record.lifecycleStatus === 'syncing'
      || record.lifecycleStatus === 'ready'));
}

/**
 * Vérifie le matériel cryptographique nécessaire AVANT la transition serveur
 * vers `lifecycle_status='ready'`.
 *
 * Cette vérification ne prétend jamais que le cycle de vie est finalisé : elle
 * exige une route approuvée/liée/active et un vrai store Libsignal local, puis
 * laisse `finalizeSynchronization()` effectuer l'unique transition serveur.
 * Séparer cette étape de `ensureReady()` évite la dépendance circulaire où la
 * synchronisation attendait un statut que seule sa propre finalisation écrit.
 */
async function ensurePreFinalizationReady(userId: string): Promise<DeviceApiSnapshot> {
  const unlocked = readPinUnlocked(userId);
  traceCurrentDeviceFinalization({
    userId,
    step: 'crypto_readiness.pre_finalize_pin_unlocked',
    outcome: unlocked ? 'success' : 'failure',
  });
  if (!unlocked) throw new Error('PIN_UNLOCK_REQUIRED');

  let snapshot = await deviceApi.getState(userId);
  if (snapshot.state === 'unregistered') throw new Error('DEVICE_NOT_REGISTERED');
  if (snapshot.state === 'pending_approval') throw new Error('DEVICE_APPROVAL_REQUIRED');
  if (snapshot.state === 'revoked') throw new Error('DEVICE_REVOKED');

  if (snapshot.state === 'binding_required') {
    await deviceApi.bind(userId);
    snapshot = await deviceApi.getState(userId);
  }

  let storePresent = Boolean(snapshot.record
    && await hasLibsignalStore(userId, snapshot.record.deviceId));
  if (!routeCanBeFinalized(snapshot) || !storePresent) {
    await deviceApi.prepareKeys(userId);
    snapshot = await deviceApi.getState(userId);
    storePresent = Boolean(snapshot.record
      && await hasLibsignalStore(userId, snapshot.record.deviceId));
  }

  const routeReady = routeCanBeFinalized(snapshot);
  const record = snapshot.record;
  traceCurrentDeviceFinalization({
    userId,
    deviceId: record?.deviceId,
    step: 'crypto_readiness.pre_finalize_device_state',
    outcome: routeReady ? 'success' : 'failure',
    errorCode: routeReady ? undefined : 'CRYPTO_NOT_READY',
    state: record ? {
      approvalStatus: record.approvalStatus,
      bindingStatus: record.bindingStatus,
      routingStatus: record.routingStatus,
      lifecycleStatus: record.lifecycleStatus,
      isActive: record.isActive,
      revoked: Boolean(record.revokedAt),
    } : null,
  });
  if (!routeReady) throw new Error(`CRYPTO_NOT_READY:${snapshot.state}`);

  traceCurrentDeviceFinalization({
    userId,
    deviceId: record?.deviceId,
    step: 'crypto_readiness.pre_finalize_owner_store_present',
    outcome: storePresent ? 'success' : 'failure',
    errorCode: storePresent ? undefined : 'AEGIS_LIBSIGNAL_STORE_MISSING',
  });
  if (!storePresent) throw new Error('AEGIS_LIBSIGNAL_STORE_MISSING');

  return snapshot;
}

async function ensureReady(userId: string): Promise<CryptoApiSnapshot> {
  const unlocked = readPinUnlocked(userId);
  traceCurrentDeviceFinalization({ userId, step: 'crypto_readiness.pin_unlocked', outcome: unlocked ? 'success' : 'failure' });
  if (!unlocked) throw new Error('PIN_UNLOCK_REQUIRED');

  let snapshot = await deviceApi.getState(userId);
  if (snapshot.state === 'unregistered') throw new Error('DEVICE_NOT_REGISTERED');
  if (snapshot.state === 'pending_approval') throw new Error('DEVICE_APPROVAL_REQUIRED');
  if (snapshot.state === 'revoked') throw new Error('DEVICE_REVOKED');

  if (snapshot.state === 'binding_required') {
    await deviceApi.bind(userId);
    snapshot = await deviceApi.getState(userId);
  }

  // Le serveur peut encore annoncer READY après une perte locale du store.
  if (snapshot.state === 'key_setup_required'
    || (snapshot.state === 'ready' && snapshot.record
      && !await hasLibsignalStore(userId, snapshot.record.deviceId))) {
    await deviceApi.prepareKeys(userId);
    snapshot = await deviceApi.getState(userId);
  }

  // La route peut être prête alors que le cycle de vie attend encore la synchronisation.
  // Observer cette distinction ne doit ni forcer READY ni contourner le coffre.
  traceCurrentDeviceFinalization({ userId, deviceId: snapshot.record?.deviceId,
    step: 'crypto_readiness.device_state', outcome: snapshot.state === 'ready' ? 'success' : 'failure',
    errorCode: snapshot.state === 'ready' ? undefined : 'CRYPTO_NOT_READY',
    state: snapshot.record ? {
      approvalStatus: snapshot.record.approvalStatus, bindingStatus: snapshot.record.bindingStatus,
      routingStatus: snapshot.record.routingStatus, lifecycleStatus: snapshot.record.lifecycleStatus,
      isActive: snapshot.record.isActive, revoked: Boolean(snapshot.record.revokedAt),
    } : null });
  if (snapshot.state !== 'ready') {
    throw new Error(`CRYPTO_NOT_READY:${snapshot.state}`);
  }

  const storePresent = Boolean(snapshot.record && await hasLibsignalStore(userId, snapshot.record.deviceId));
  traceCurrentDeviceFinalization({ userId, deviceId: snapshot.record?.deviceId,
    step: 'crypto_readiness.owner_store_present', outcome: storePresent ? 'success' : 'failure' });
  if (!storePresent) {
    throw new Error('AEGIS_LIBSIGNAL_STORE_MISSING');
  }

  return { state: 'ready', device: snapshot };
}

export const cryptoApi = {
  getState,
  ensurePreFinalizationReady,
  ensureReady,
  isUnlocked: (userId: string) => readPinUnlocked(userId),
} as const;
