import { runTxOn, reqToPromise } from '@/lib/crypto/indexedDbTx';

const STORE = 'sessions';

type StoredSessionRecord = Record<string, unknown> & { id: string };
type SessionSnapshot = { key: string; value: StoredSessionRecord | null };

const attempts = new Map<string, Map<string, SessionSnapshot>>();

function compositeKey(
  myUserId: string,
  myDeviceId: string,
  peerUserId: string,
  peerDeviceId: string,
): string {
  return `${myUserId}::${myDeviceId}::${peerUserId}::${peerDeviceId}`;
}

/**
 * Captures the exact persisted state before a target ratchet is advanced or a
 * new X3DH session is installed. Multiple captures for the same target and
 * message keep the first snapshot only.
 *
 * A storage read failure is not equivalent to an absent session. It is allowed
 * to abort this target/send, but never to manufacture a null snapshot that
 * could delete a real ratchet during rollback.
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

  const existing = await runTxOn('device-sessions', [STORE], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE).get(key) as IDBRequest<StoredSessionRecord | undefined>),
  );

  transaction.set(key, {
    key,
    value: existing ? structuredClone(existing) : null,
  });
}

/**
 * Restores every target session to its pre-attempt state after an explicit
 * server rejection. A target that had no session before the attempt is deleted,
 * which also rolls back a newly-created X3DH initiator session.
 */
export async function rollbackFanoutSessionTransaction(messageId: string): Promise<number> {
  const transaction = attempts.get(messageId);
  if (!transaction || transaction.size === 0) return 0;

  const snapshots = [...transaction.values()];
  await runTxOn('device-sessions', [STORE], 'readwrite', (tx) => {
    const store = tx.objectStore(STORE);
    for (const snapshot of snapshots) {
      if (snapshot.value) store.put(structuredClone(snapshot.value));
      else store.delete(snapshot.key);
    }
  });
  attempts.delete(messageId);
  return snapshots.length;
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