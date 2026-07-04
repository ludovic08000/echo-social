/**
 * Session archiving (Signal `SessionRecord.previousStates` model).
 *
 * Why
 * ---
 * When a peer's identity key changes (reinstall, restore, new device), the old
 * approach DELETED the ratchet for that conversation. Any message the peer had
 * already encrypted under the OLD session then became permanently undecryptable
 * — the "some messages stay encrypted after an iOS key change" symptom.
 *
 * Signal never deletes on key change: it archives the current session into a
 * bounded `previousStates` list and starts a fresh one. Decryption tries the
 * current session first, then walks the archived sessions. This module provides
 * that archive, stored alongside the live ratchet in the same IndexedDB store
 * under a namespaced key so it never collides with `loadRatchetLocal`.
 */
import { runTxOn, reqToPromise } from './indexedDbTx';
import { RATCHET_STORE_NAME } from './ratchetStore';
import {
  serializeRatchetState,
  deserializeRatchetState,
  ratchetDecrypt,
  type RatchetState,
  type RatchetEnvelope,
} from './ratchet';

/** Max archived sessions per conversation (Signal keeps ~40; we cap lower). */
export const MAX_ARCHIVED_SESSIONS = 20;

interface ArchivedEntry {
  data: string;        // serialized RatchetState
  archivedAt: number;  // epoch ms
}

interface ArchiveRecord {
  convId: string;      // namespaced key (see archiveKey)
  archive: ArchivedEntry[];
}

function archiveKey(convId: string): string {
  return `__ratchet_archive__:${convId}`;
}

/**
 * Keep only the newest `max` entries. Pure — assumes `list` is ordered
 * oldest → newest, returns a new array. Exported for unit testing.
 */
export function capArchive(list: ArchivedEntry[], max: number): ArchivedEntry[] {
  if (list.length <= max) return list.slice();
  return list.slice(list.length - max);
}

async function readArchive(convId: string): Promise<ArchivedEntry[]> {
  try {
    const rec = await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readonly', (tx) =>
      reqToPromise<ArchiveRecord | undefined>(
        tx.objectStore(RATCHET_STORE_NAME).get(archiveKey(convId)),
      ),
    );
    return Array.isArray(rec?.archive) ? rec!.archive : [];
  } catch {
    return [];
  }
}

async function writeArchive(convId: string, archive: ArchivedEntry[]): Promise<void> {
  const record: ArchiveRecord = { convId: archiveKey(convId), archive };
  await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
    tx.objectStore(RATCHET_STORE_NAME).put(record);
  });
}

/**
 * Archive the current live ratchet state before it is replaced/reset. Newest
 * entries are appended at the end; the list is capped to MAX_ARCHIVED_SESSIONS.
 * Best-effort: never throws (a failed archive must not block key rotation).
 */
export async function archiveRatchetState(convId: string, state: RatchetState): Promise<void> {
  try {
    const serialized = await serializeRatchetState(state);
    const existing = await readArchive(convId);
    const next = capArchive(
      [...existing, { data: serialized, archivedAt: Date.now() }],
      MAX_ARCHIVED_SESSIONS,
    );
    await writeArchive(convId, next);
  } catch (e) {
    console.warn('[E2EE][ARCHIVE] failed to archive ratchet state', e);
  }
}

/** Load archived states, newest first. Best-effort. */
export async function loadArchivedRatchetStates(convId: string): Promise<RatchetState[]> {
  const entries = await readArchive(convId);
  const out: RatchetState[] = [];
  // newest first
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      out.push(await deserializeRatchetState(entries[i].data));
    } catch {
      /* skip corrupt entry */
    }
  }
  return out;
}

export async function clearArchivedRatchetStates(convId: string): Promise<void> {
  try {
    await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
      tx.objectStore(RATCHET_STORE_NAME).delete(archiveKey(convId));
    });
  } catch {
    /* ignore */
  }
}

/**
 * Export the raw archive entries as a JSON string for encrypted off-device
 * sync. Returns null if there is nothing to sync. Does NOT touch the network —
 * the caller encrypts + uploads (see encryptedSessionSync).
 */
export async function exportArchiveJson(convId: string): Promise<string | null> {
  const entries = await readArchive(convId);
  if (!entries.length) return null;
  try {
    return JSON.stringify(entries);
  } catch {
    return null;
  }
}

/**
 * Restore archive entries from a JSON string previously produced by
 * exportArchiveJson (e.g. after a local purge). Merges by keeping the newest
 * MAX_ARCHIVED_SESSIONS across local + restored. Best-effort.
 */
export async function importArchiveJson(convId: string, json: string): Promise<void> {
  try {
    const restored = JSON.parse(json) as ArchivedEntry[];
    if (!Array.isArray(restored)) return;
    const existing = await readArchive(convId);
    const merged = capArchive(
      [...existing, ...restored].sort((a, b) => a.archivedAt - b.archivedAt),
      MAX_ARCHIVED_SESSIONS,
    );
    await writeArchive(convId, merged);
  } catch {
    /* ignore corrupt payload */
  }
}

/**
 * Try to decrypt an envelope against archived sessions, newest first. On the
 * first success, the advanced state is written back into that archive slot so
 * further late messages from the same old session keep decrypting in order.
 * Returns the plaintext + verified flag, or null if no archived session works.
 */
export async function tryDecryptWithArchivedSessions(
  convId: string,
  envelope: RatchetEnvelope,
  peerSigningKeyB64?: string,
): Promise<{ plaintext: string; verified: boolean } | null> {
  const entries = await readArchive(convId);
  // Iterate newest → oldest.
  for (let i = entries.length - 1; i >= 0; i--) {
    let state: RatchetState;
    try {
      state = await deserializeRatchetState(entries[i].data);
    } catch {
      continue;
    }
    try {
      const { plaintext, verified, newState } = await ratchetDecrypt(state, envelope, peerSigningKeyB64);
      // Persist the advanced archived state back into its slot (best-effort).
      try {
        const reserialized = await serializeRatchetState(newState);
        const updated = entries.slice();
        updated[i] = { ...updated[i], data: reserialized };
        await writeArchive(convId, updated);
      } catch {
        /* non-fatal */
      }
      return { plaintext, verified };
    } catch {
      // This archived session couldn't decrypt it; try the next one.
    }
  }
  return null;
}
