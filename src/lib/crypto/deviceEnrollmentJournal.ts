import { STORE_KEYS } from './constants';
import { reqToPromise, runTx } from './indexedDbTx';
import type { DeviceEnrollmentChallenge } from './serverDeviceEnrollment';

// Journal de reprise uniquement : aucune clé privée ni décision d'approbation.
const idFor = (userId: string) => `device-enrollment-pending::${userId}`;

export async function readEnrollmentJournal(userId: string): Promise<DeviceEnrollmentChallenge | null> {
  const row = await runTx([STORE_KEYS], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_KEYS).get(idFor(userId))));
  if (!row) return null;
  if (row.userId !== userId || !/^dev_[a-f0-9]{32}$/.test(row.challenge?.deviceId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.challenge?.challengeId)
      || typeof row.challenge?.nonce !== 'string' || row.challenge.nonce.length < 32
      || typeof row.challenge?.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.challenge.expiresAt))) {
    throw new Error('DEVICE_ENROLLMENT_JOURNAL_INVALID');
  }
  return row.challenge;
}

export async function writeEnrollmentJournal(userId: string, challenge: DeviceEnrollmentChallenge): Promise<void> {
  await runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).put({ id: idFor(userId), userId, challenge });
  });
}

export async function clearEnrollmentJournal(userId: string): Promise<void> {
  await runTx([STORE_KEYS], 'readwrite', (tx) => { tx.objectStore(STORE_KEYS).delete(idFor(userId)); });
}
