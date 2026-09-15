import { runCrossTabExclusive } from './crossTabLock';

/** Le coffre contient toutes les sessions : le verrou porte sur l'appareil,
 * jamais seulement sur une conversation, et reste partagé entre onglets. */
export function withLibsignalStoreLock<T>(
  userId: string,
  deviceId: string,
  work: () => Promise<T>,
): Promise<T> {
  return runCrossTabExclusive(
    `aegis:libsignal-store:${JSON.stringify([userId, deviceId])}`,
    work,
  );
}
