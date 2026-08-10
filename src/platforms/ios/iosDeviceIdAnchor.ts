/**
 * Ancrage iOS du DeviceID dans le coffre critique (Keychain natif, ACE Web
 * sous Safari/Chrome iOS).
 *
 * Invariant : cet ancrage ne CRÉE jamais de DeviceID. Il ne fait que persister
 * et relire l'identifiant déjà attribué par le serveur, afin qu'une purge ITP
 * de localStorage/IndexedDB n'entraîne aucune rotation d'appareil.
 * Aucun effet hors runtime iOS : le flux Windows reste strictement inchangé.
 */
import { iosKeychainGet, iosKeychainSet } from '@/platforms/ios/keychain';
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';

const ANCHOR_PREFIX = 'ios.device-id-anchor.v1:';
const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

function anchorKey(storageKey: string): string {
  return `${ANCHOR_PREFIX}${storageKey}`;
}

/** Lecture non bloquante : renvoie null hors iOS ou si l'ancrage est absent. */
export async function readIosDeviceIdAnchor(storageKey: string): Promise<string | null> {
  if (!isIosRuntime()) return null;
  try {
    const value = await iosKeychainGet(anchorKey(storageKey));
    return typeof value === 'string' && SERVER_DEVICE_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Écriture best-effort : ne doit jamais faire échouer la persistance existante. */
export async function writeIosDeviceIdAnchor(storageKey: string, deviceId: string): Promise<boolean> {
  if (!isIosRuntime() || !SERVER_DEVICE_ID_RE.test(deviceId)) return false;
  try {
    const existing = await iosKeychainGet(anchorKey(storageKey));
    if (existing === deviceId) return true;
    await iosKeychainSet(anchorKey(storageKey), deviceId);
    return true;
  } catch {
    return false;
  }
}

/** Diagnostic : l'appareil iOS courant possède-t-il un DeviceID ancré ? */
export async function hasIosDeviceIdAnchor(storageKey: string): Promise<boolean> {
  return (await readIosDeviceIdAnchor(storageKey)) !== null;
}
