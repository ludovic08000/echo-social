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
  