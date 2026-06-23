/**
 * C1 — On-device Sender Key state store.
 *
 * SECURITY INVARIANT (audit finding C1):
 *   The Sender Key chain key (`chainKeyB64`) and the owner's signing PRIVATE
 *   key (`signingPrivJwk`) are SECRET. They derive every group message key and
 *   authenticate the sender. They MUST NEVER leave the device.
 *
 *   Previously these were persisted in the Supabase table `sender_key_state`,
 *   which let the server (or anyone with DB access) decrypt and forge every
 *   group message. This module replaces that with a local IndexedDB store so
 *   the secret material is device-only — matching the WhatsApp/Signal model
 *   where Sender Key state lives exclusively on member devices.
 *
 * The server keeps only NON-secret presence rows (conversation/sender/device
 * ids, `is_owner`, public signing key, iteration) so multi-device ownership
 * signalling and the rotation watcher keep working — see `senderKeySession.ts`.
 */
import { runTxOn, reqToPromise } from './indexedDbTx';

const DB_KEY = 'sk-state' as const;
const STORE = 'sk-states';

export interface LocalSenderKeyState {
  /** `${conversationId}::${senderUserId}::${senderDeviceId}::${role}` */
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  isOwner: boolean;
  iteration: number;
  chainKeyB64: string;
  signingPubB64: string;
  /** Owner only; null for recipient mirrors. */
  signingPrivJwk: JsonWebKey | null;
  /** Chain generation birth time — used for age-based auto-rotation (L5). */
  createdAt: number;
  updatedAt: number;
}

function stateId(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
  isOwner: boolean,
): string {
  return `${conversationId}::${senderUserId}::${senderDeviceId}::${isOwner ? 'o' : 'r'}`;
}

export async function putLocalState(s: LocalSenderKeyState): Promise<void> {
  await runTxOn(DB_KEY, [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).put(s);
  });
}

export async function getLocalState(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
  isOwner: boolean,
): Promise<LocalSenderKeyState | null> {
  try {
    const id = stateId(conversationId, senderUserId, senderDeviceId, isOwner);
    const result = await runTxOn(DB_KEY, [STORE], 'readonly', (tx) =>
      reqToPromise<LocalSenderKeyState | undefined>(tx.objectStore(STORE).get(id)),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

export async function deleteLocalState(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
  isOwner: boolean,
): Promise<void> {
  try {
    const id = stateId(conversationId, senderUserId, senderDeviceId, isOwner);
    await runTxOn(DB_KEY, [STORE], 'readwrite', (tx) => {
      tx.objectStore(STORE).delete(id);
    });
  } catch {
    /* best-effort */
  }
}

async function getAllLocalStates(): Promise<LocalSenderKeyState[]> {
  try {
    const all = await runTxOn(DB_KEY, [STORE], 'readonly', (tx) =>
      reqToPromise<LocalSenderKeyState[]>(tx.objectStore(STORE).getAll()),
    );
    return all ?? [];
  } catch {
    return [];
  }
}

/**
 * Resolve a recipient mirror from a wire that only carries
 * `(conversationId, senderDeviceId)` — the sender user id is not on the wire,
 * so we scan recipient states for the match.
 */
export async function findRecipientStateByWire(
  conversationId: string,
  senderDeviceId: string,
): Promise<LocalSenderKeyState | null> {
  const all = await getAllLocalStates();
  return (
    all.find(
      (s) =>
        !s.isOwner &&
        s.conversationId === conversationId &&
        s.senderDeviceId === senderDeviceId,
    ) ?? null
  );
}

/** Enumerate owner chains for a given device (used by the rotation watcher). */
export async function listOwnerStatesForDevice(
  senderUserId: string,
  senderDeviceId: string,
): Promise<LocalSenderKeyState[]> {
  const all = await getAllLocalStates();
  return all.filter(
    (s) => s.isOwner && s.senderUserId === senderUserId && s.senderDeviceId === senderDeviceId,
  );
}
