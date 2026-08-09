import { deviceApi, type DeviceApiSnapshot } from '@/lib/api/deviceApi';
import { readPinUnlocked } from '@/lib/device-manager/pinUnlockSignal';

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

async function ensureReady(userId: string): Promise<CryptoApiSnapshot> {
  if (!readPinUnlocked(userId)) throw new Error('PIN_UNLOCK_REQUIRED');

  let snapshot = await deviceApi.getState(userId);
  if (snapshot.state === 'unregistered') throw new Error('DEVICE_NOT_REGISTERED');
  if (snapshot.state === 'pending_approval') throw new Error('DEVICE_APPROVAL_REQUIRED');
  if (snapshot.state === 'revoked') throw new Error('DEVICE_REVOKED');

  if (snapshot.state === 'binding_required') {
    await deviceApi.bind(userId);
    snapshot = await deviceApi.getState(userId);
  }

  if (snapshot.state === 'key_setup_required') {
    await deviceApi.prepareKeys(userId);
    snapshot = await deviceApi.getState(userId);
  }

  if (snapshot.state !== 'ready') {
    throw new Error(`CRYPTO_NOT_READY:${snapshot.state}`);
  }

  return { state: 'ready', device: snapshot };
}

export const cryptoApi = {
  getState,
  ensureReady,
  isUnlocked: (userId: string) => readPinUnlocked(userId),
} as const;
