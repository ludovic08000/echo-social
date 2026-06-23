const WINDOW_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

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
