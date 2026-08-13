import { runDeviceSessionJob } from '@/lib/crypto/deviceSessionQueue';
import {
  readDeviceSessionRecord,
  removeDeviceSessionRecord,
  writeDeviceSessionRecord,
} from '@/lib/crypto/deviceSessionStore';

const SESSION_STORE = 'sessions';
const INITIATING_STORE = 'initiating-sessions';

type StoredRecord = Record<string, unknown> & { id: string };
type PairSnapshot = {
  key: string;
  session: StoredRecord | null;
  initiating: StoredRecord | null;
};

const attempts = new Map<string, Map<string, PairSnapshot>>();

async function restoreSnapshot(snapshot: PairSnapshot): Promise<void> {
  await runDeviceSessionJob('route', snapshot.key, () => Promise.all([
    snapshot.session
      ? writeDeviceSessionRecord(SESSION_STORE, structuredClone(snapshot.session))
      : removeDeviceSessionRecord(SESSION_STORE, snapshot.key),
    snapshot.initiating
      ? writeDeviceSessionRecord(INITIATING_STORE, structuredClone(snapshot.initiating))
      : removeDeviceSessionRecord(INITIATING_STORE, snapshot.key),
  ]).then(() => undefined));
}

function compositeKey(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): string {
  return `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`;
}

/**
 * Captures the complete pair state before a ratchet advance or X3DH bootstrap:
 * both the Double Ratchet record and the repeatable initiating-envelope record.
 * Multiple captures for the same target and message keep the first snapshot.
 *
 * A storage read failure aborts the send. It is never converted into a null
 * snapshot because rollback could otherwise delete a real session.
 */
export async function captureFanoutSessionBeforeMutation(args: {
  messageId: string;
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
}): Promise<void> {
  if (!args.messageId) return;
  const key = compositeKey(
    args.myUserId,
    args.myDeviceId,
    args.peerUserId,
    args.peerDeviceId,
  );

  let transaction = attempts.get(args.messageId);
  if (!transaction) {
    transaction = new Map();
    attempts.set(args.messageId, transaction);
  }
  if (transaction.has(key)) return;

  const snapshot = await Promise.all([
    readDeviceSessionRecord<StoredRecord>(SESSION_STORE, key),
    readDeviceSessionRecord<StoredRecord>(INITIATING_STORE, key),
  ]);

  transaction.set(key, {
    key,
    session: snapshot[0] ? structuredClone(snapshot[0]) : null,
    initiating: snapshot[1] ? structuredClone(snapshot[1]) : null,
  });
}

/**
 * Restores every target pair to its exact pre-attempt state after an explicit
 * server rejection. Newly-created ratchets and initiation headers are deleted;
 * pre-existing records and counters are restored.
 */
export async function rollbackFanoutSessionTransaction(messageId: string): Promise<number> {
  const transaction = attempts.get(messageId);
  if (!transaction || transaction.size === 0) return 0;

  const snapshots = [...transaction.values()];
  await Promise.all(snapshots.map(restoreSnapshot));
  attempts.delete(messageId);
  return snapshots.length;
}

/**
 * Restores only one failed fan-out target. Successful device envelopes remain
 * committed to their advanced ratchets, while a stale/unavailable device can
 * be omitted without silently consuming a sending-chain key.
 */
export async function rollbackFanoutSessionTarget(args: {
  messageId: string;
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
}): Promise<boolean> {
  const transaction = attempts.get(args.messageId);
  if (!transaction) return false;
  const key = compositeKey(
    args.myUserId,
    args.myDeviceId,
    args.peerUserId,
    args.peerDeviceId,
  );
  const snapshot = transaction.get(key);
  if (!snapshot) return false;

  await restoreSnapshot(snapshot);
  transaction.delete(key);
  if (transaction.size === 0) attempts.delete(args.messageId);
  return true;
}

/** Clears snapshots only after the server transaction has committed. */
export function commitFanoutSessionTransaction(messageId: string): void {
  attempts.delete(messageId);
}

export function hasFanoutSessionTransaction(messageId: string): boolean {
  return (attempts.get(messageId)?.size ?? 0) > 0;
}

export const __test__ = {
  reset(): void {
    attempts.clear();
  },
};
