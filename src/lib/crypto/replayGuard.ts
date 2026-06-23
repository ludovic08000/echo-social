import { runTxOn, reqToPromise } from './indexedDbTx';

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

// M4 — persistent ledger settings (survives reloads/restarts, unlike the
// in-memory map which only deduped within a 5-minute window in a single tab).
const PERSIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PERSIST_DB = 'replay-ledger' as const;
const PERSIST_STORE = 'seen';

interface ReplayEntry {
  id: string;
  ts: number;
}

const seen = new Map<string, ReplayEntry>();

function cleanup() {
  const now = Date.now();

  for (const [key, entry] of seen.entries()) {
    if (now - entry.ts > WINDOW_MS) {
      seen.delete(key);
    }
  }

  if (seen.size <= MAX_ENTRIES) return;

  const ordered = [...seen.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const overflow = seen.size - MAX_ENTRIES;
  for (let i = 0; i < overflow; i++) {
    seen.delete(ordered[i][0]);
  }
}

export function computeReplayKey(parts: Array<string | number | undefined | null>): string {
  return parts.map((p) => String(p ?? '')).join('::');
}

export function markReplaySeen(replayKey: string): void {
  cleanup();
  seen.set(replayKey, {
    id: replayKey,
    ts: Date.now(),
  });
}

export function isReplay(replayKey: string): boolean {
  cleanup();
  return seen.has(replayKey);
}

export function assertNotReplay(replayKey: string): void {
  if (isReplay(replayKey)) {
    throw new Error('REPLAY_DETECTED');
  }

  markReplaySeen(replayKey);
}

// ─── M4: persistent (cross-restart) anti-replay ────────────────────────────

interface PersistEntry {
  id: string;
  ts: number;
}

async function persistCleanup(): Promise<void> {
  try {
    const cutoff = Date.now() - PERSIST_WINDOW_MS;
    await runTxOn(PERSIST_DB, [PERSIST_STORE], 'readwrite', (tx) => new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(PERSIST_STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(); return; }
        const rec = cursor.value as PersistEntry;
        if (typeof rec.ts === 'number' && rec.ts < cutoff) cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    }));
  } catch {
    /* best-effort GC */
  }
}

/**
 * Durable replay check. Throws `REPLAY_DETECTED` if `replayKey` was seen
 * before (in memory OR in the on-disk ledger). Persisting to IndexedDB makes
 * the guard effective across reloads/restarts and for a 7-day window, instead
 * of only within a single 5-minute in-memory session.
 *
 * Best-effort on storage errors: if IndexedDB is unavailable we still enforce
 * the in-memory guard so we never fail open on the happy path.
 */
export async function assertNotReplayPersistent(replayKey: string): Promise<void> {
  // Fast in-memory check first.
  if (isReplay(replayKey)) throw new Error('REPLAY_DETECTED');

  let seenOnDisk = false;
  try {
    const existing = await runTxOn(PERSIST_DB, [PERSIST_STORE], 'readonly', (tx) =>
      reqToPromise<PersistEntry | undefined>(tx.objectStore(PERSIST_STORE).get(replayKey)),
    );
    seenOnDisk = !!existing;
  } catch {
    seenOnDisk = false; // storage unavailable → rely on in-memory guard
  }
  if (seenOnDisk) throw new Error('REPLAY_DETECTED');

  // Record in both layers.
  markReplaySeen(replayKey);
  try {
    await runTxOn(PERSIST_DB, [PERSIST_STORE], 'readwrite', (tx) => {
      tx.objectStore(PERSIST_STORE).put({ id: replayKey, ts: Date.now() } as PersistEntry);
    });
    void persistCleanup();
  } catch {
    /* best-effort persist */
  }
}
