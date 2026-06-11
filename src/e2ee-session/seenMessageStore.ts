/**
 * In-memory anti-replay / dedup store for inbound E2EE envelopes.
 *
 * Scope: process lifetime. Cleared on reload (we rely on the server-side
 * `messages` table to be the source of truth for what has been delivered).
 * Bounded by `MAX_ENTRIES` to avoid unbounded RAM growth on long sessions.
 *
 * Usage rule: ONLY mark seen AFTER a successful decrypt-and-deliver. A
 * pending retry must NOT mark the key — otherwise a transiently-failed
 * message would be silently dropped on the next refetch.
 */

const MAX_ENTRIES = 5000;
const seen = new Set<string>();
const order: string[] = [];

export interface SeenKeyInput {
  messageId?: string;
  sessionId?: string;
  seq?: number;
  ciphertextHash?: string;
}

export function makeSeenKey(input: SeenKeyInput): string {
  return [
    input.messageId ?? 'no-mid',
    input.sessionId ?? 'no-sid',
    input.seq ?? 'no-seq',
    input.ciphertextHash ?? 'no-hash',
  ].join(':');
}

export function hasSeenMessage(key: string): boolean {
  return seen.has(key);
}

export function markSeenMessage(key: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  order.push(key);
  if (order.length > MAX_ENTRIES) {
    const drop = order.shift();
    if (drop) seen.delete(drop);
  }
}

/** Test helper. */
export function _resetSeenStore(): void {
  seen.clear();
  order.length = 0;
}
