/**
 * Réutilisation d'appareil iOS.
 *
 * Invariant : sur iOS, on ne crée JAMAIS un nouveau device tant qu'une identité
 * locale (clé de signature + clé KX) existe pour un DeviceID déjà attribué par
 * le serveur. L'ancrage Keychain sert de source de vérité quand WebKit a purgé
 * localStorage/IndexedDB.
 *
 * Ce module ne s'exécute que sur iOS : le flux Windows (WebAuthn / Windows
 * Hello / lifecycle validé) n'emprunte jamais ce chemin.
 */
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';
import { readIosDeviceIdAnchor } from '@/platforms/ios/iosDeviceIdAnchor';
import { iosDeviceIdStorageKey } from '@/platforms/ios/iosDeviceIdStorageKey';
import { recordIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { peekCurrentDeviceId, setCurrentDeviceId } from '@/lib/messaging/currentDevice';

const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

export interface IosReusableDevice {
  deviceId: string;
  source: 'current' | 'keychain-anchor';
}

/**
 * Returns the stable local iOS DeviceID even when its private keys need vault
 * restoration. Its presence is continuity evidence and must block creation of
 * a replacement DeviceID.
 */
export async function resolveExistingIosDevice(userId: string): Promise<IosReusableDevice | null> {
  if (!isIosRuntime() || !userId) return null;
  const current = peekCurrentDeviceId();
  if (current && SERVER_DEVICE_ID_RE.test(current)) {
    return { deviceId: current, source: 'current' };
  }
  const anchored = await readIosDeviceIdAnchor(iosDeviceIdStorageKey(userId));
  return anchored && SERVER_DEVICE_ID_RE.test(anchored)
    ? { deviceId: anchored, source: 'keychain-anchor' }
    : null;
}

/**
 * Renvoie le DeviceID iOS réutilisable, ou null si un enrôlement est réellement
 * nécessaire. N'écrit rien côté serveur et ne génère aucun identifiant.
 */
export async function resolveReusableIosDevice(userId: string): Promise<IosReusableDevice | null> {
  if (!isIosRuntime() || !userId) return null;

  const current = peekCurrentDeviceId();
  const candidates: IosReusableDevice[] = [];
  if (current && SERVER_DEVICE_ID_RE.test(current)) {
    candidates.push({ deviceId: current, source: 'current' });
  }

  const anchored = await readIosDeviceIdAnchor(iosDeviceIdStorageKey(userId));
  if (anchored && anchored !== current) {
    candidates.push({ deviceId: anchored, source: 'keychain-anchor' });
  }

  for (const candidate of candidates) {
    try {
      const [identity, kx] = await Promise.all([
        loadDeviceIdentity(userId, candidate.deviceId),
        loadDeviceKxKey(candidate.deviceId, userId),
      ]);
      if (identity && kx) return candidate;
    } catch (error) {
      recordIosRpcError('ios.reuse.local-identity-lookup', error);
    }
  }

  return null;
}

export function adoptExistingIosDevice(existing: IosReusableDevice): string {
  return existing.source === 'current'
    ? existing.deviceId
    : setCurrentDeviceId(existing.deviceId);
}

/**
 * Adopte le DeviceID iOS réutilisable pour la session courante.
 * Retourne le DeviceID adopté, ou null si aucun n'est réutilisable.
 */
export async function adoptReusableIosDevice(userId: string): Promise<string | null> {
  const reusable = await resolveReusableIosDevice(userId);
  if (!reusable) return null;
  if (reusable.source === 'current') return reusable.deviceId;
  try {
    return setCurrentDeviceId(reusable.deviceId);
  } catch (error) {
    // DEVICE_ID_MISMATCH : on laisse la machine d'état gérer, sans rotation silencieuse.
    recordIosRpcError('ios.reuse.adopt-device-id', error);
    return null;
  }
}
