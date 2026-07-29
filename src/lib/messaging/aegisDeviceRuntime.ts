import { ensureUserE2EEIdentity } from '@/lib/crypto/identityBootstrap';
import {
  getCurrentDeviceId,
  hydrateDeviceId,
  isDeviceIdTemporary,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';

type ReadyDevice = Readonly<{
  deviceId: string;
  expiresAt: number;
  userId: string;
}>;

const DEVICE_READINESS_TTL_MS = 30_000;
const readyByUser = new Map<string, ReadyDevice>();
const initializingByUser = new Map<string, Promise<ReadyDevice>>();

/**
 * Establishes the stable Aegis installation before any route or ratchet work.
 *
 * This mirrors the useful lifecycle guarantee of MatrixClient initialization:
 * concurrent callers share one initialization, and a temporary installation
 * identifier is never allowed to enter the encrypted delivery pipeline.
 */
export async function ensureAegisDeviceReady(userId: string): Promise<ReadyDevice> {
  if (!userId) throw new Error('AEGIS_USER_ID_REQUIRED');

  setCurrentDeviceUserScope(userId);
  const cached = readyByUser.get(userId);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.deviceId === getCurrentDeviceId() &&
    !isDeviceIdTemporary()
  ) {
    return cached;
  }

  const active = initializingByUser.get(userId);
  if (active) return active;

  const initialization = (async () => {
    const deviceId = await hydrateDeviceId();
    if (!deviceId || isDeviceIdTemporary()) {
      throw new Error('E2EE_STABLE_DEVICE_REQUIRED');
    }

    // Registration, identity binding and prekey publication must complete
    // before fan-out reads the authoritative device route.
    await ensureUserE2EEIdentity(userId, { waitForMaintenance: true });

    const ready = {
      deviceId,
      expiresAt: Date.now() + DEVICE_READINESS_TTL_MS,
      userId,
    } as const;
    readyByUser.set(userId, ready);
    return ready;
  })().catch((error) => {
    readyByUser.delete(userId);
    throw error;
  }).finally(() => {
    if (initializingByUser.get(userId) === initialization) {
      initializingByUser.delete(userId);
    }
  });

  initializingByUser.set(userId, initialization);
  return initialization;
}

export function invalidateAegisDeviceRuntime(userId?: string): void {
  if (userId) {
    readyByUser.delete(userId);
    initializingByUser.delete(userId);
    return;
  }
  readyByUser.clear();
  initializingByUser.clear();
}

export const __test__ = {
  readinessTtlMs: DEVICE_READINESS_TTL_MS,
  reset: invalidateAegisDeviceRuntime,
};
