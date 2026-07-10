/**
 * Bounded previous-session archive for late messages after a key change.
 *
 * Archives remain device-local. Off-device archive export functions are kept
 * for wire compatibility, but encryptedSessionSync refuses to upload them.
 */
import { runTxOn, reqToPromise } from './indexedDbTx';
import { RATCHET_STORE_NAME } from './ratchetStore';
import {
  serializeRatchetState,
  deserializeRatchetState,
  type RatchetState,
  type RatchetEnvelope,
} from './ratchet';
import { ratchetDecrypt } from './ratchetSafe';

export const MAX_ARCHIVED_SESSIONS = 20;

interface ArchivedEntry {
  data: string;
  archivedAt: number;
}

interface ArchiveRecord {
  convId: string;
  archive: ArchivedEntry[];
}

function archiveKey(convId: string): string {
  return `__ratchet_archive__:${convId}`;
}

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

export async function archiveRatchetState(convId: string, state: RatchetState): Promise<void> {
  try {
    const serialized = await serializeRatchetState(state);
    const existing = await readArchive(convId);
    const next = capArchive(
      [...existing, { data: serialized, archivedAt: Date.now() }],
      MAX_ARCHIVED_SESSIONS,
    );
    await writeArchive(convId, next);
  } catch (error) {
    console.warn('[E2EE][ARCHIVE] failed to archive ratchet state', error);
  }
}

export async function loadArchivedRatchetStates(convId: string): Promise<RatchetState[]> {
  const entries = await readArchive(convId);
  const out: RatchetState[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      out.push(await deserializeRatchetState(entries[i].data));
    } catch {
      // Skip corrupt entries.
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
    // Ignore local cleanup failures.
  }
}

export async function exportArchiveJson(convId: string): Promise<string | null> {
  const entries = await readArchive(convId);
  if (!entries.length) return null;
  try {
    return JSON.stringify(entries);
  } catch {
    return null;
  }
}

export async function importArchiveJson(convId: string, json: string): Promise<void> {
  try {
    const restored = JSON.parse(json) as ArchivedEntry[];
    if (!Array.isArray(restored)) return;
    const existing = await readArchive(convId);
    const merged = capArchive(
      [...existing, ...restored]
        .filter((entry) => entry && typeof entry.data === 'string' && Number.isFinite(entry.archivedAt))
        .sort((a, b) => a.archivedAt - b.archivedAt),
      MAX_ARCHIVED_SESSIONS,
    );
    await writeArchive(convId, merged);
  } catch {
    // Ignore corrupt legacy payloads.
  }
}

export async function tryDecryptWithArchivedSessions(
  convId: string,
  envelope: RatchetEnvelope,
  peerSigningKeyB64?: string,
): Promise<{ plaintext: string; verified: boolean } | null> {
  const entries = await readArchive(convId);
  for (let i = entries.length - 1; i >= 0; i--) {
    let state: RatchetState;
    try {
      state = await deserializeRatchetState(entries[i].data);
    } catch {
      continue;
    }

    try {
      const { plaintext, verified, newState } = await ratchetDecrypt(
        state,
        envelope,
        peerSigningKeyB64,
      );
      try {
        const updated = entries.slice();
        updated[i] = {
          ...updated[i],
          data: await serializeRatchetState(newState),
        };
        await writeArchive(convId, updated);
      } catch {
        // Advancing the archive is best-effort.
      }
      return { plaintext, verified };
    } catch {
      // Try the next previous session.
    }
  }
  return null;
}
