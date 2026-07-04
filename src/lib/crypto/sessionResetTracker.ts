/**
 * Session-reset accounting (WhatsApp-style explicit session reset).
 *
 * Refanout re-sends the SAME ciphertext; it cannot fix a conversation whose
 * cryptographic session is desynchronised (e.g. our ratchet came from a stale
 * handshake and the peer has moved on). For that, the recovery is a full
 * renegotiation: purge the local ratchet and rotate our signed prekey so the
 * peer re-runs X3DH on its next send — a "session reset".
 *
 * That reset already exists in the pairwise decrypt self-heal, but it fired on
 * the FIRST terminal failure with no bound — a single transient blip could
 * trigger an SPK rotation, and a run of failures could cause a handshake storm.
 *
 * This module makes the reset deliberate and bounded:
 *   - only after FAIL_THRESHOLD persistent failures for a conversation,
 *   - at most once per RESET_COOLDOWN_MS,
 *   - at most MAX_RESETS_PER_WINDOW within RESET_WINDOW_MS (hard anti-storm cap).
 *
 * Scope: in-memory, process lifetime. A reload starts fresh (the ratchet is
 * reloaded from storage at that point anyway).
 */

export const FAIL_THRESHOLD = 3;
export const RESET_COOLDOWN_MS = 60_000;      // 1 min between resets per conversation
export const RESET_WINDOW_MS = 30 * 60_000;   // 30 min window for the storm cap
export const MAX_RESETS_PER_WINDOW = 3;

const MAX_ENTRIES = 2000;

interface ResetEntry {
  fails: number;
  resetsAt: number[];   // timestamps of resets performed (within the window)
  lastResetAt: number;  // 0 if never
}

const state = new Map<string, ResetEntry>();

export interface ResetDecision {
  shouldReset: boolean;
  reason: 'below_threshold' | 'cooldown' | 'storm_cap' | 'reset';
  fails: number;
}

function prune(resetsAt: number[], now: number): number[] {
  return resetsAt.filter((t) => now - t < RESET_WINDOW_MS);
}

/**
 * Pure decision helper (exported for tests): given the current entry and now,
 * decide whether a session reset is warranted.
 */
export function decideReset(entry: ResetEntry | undefined, now: number): ResetDecision {
  const fails = (entry?.fails ?? 0) + 1;
  if (fails < FAIL_THRESHOLD) {
    return { shouldReset: false, reason: 'below_threshold', fails };
  }
  if (entry && entry.lastResetAt && now - entry.lastResetAt < RESET_COOLDOWN_MS) {
    return { shouldReset: false, reason: 'cooldown', fails };
  }
  const recentResets = entry ? prune(entry.resetsAt, now).length : 0;
  if (recentResets >= MAX_RESETS_PER_WINDOW) {
    return { shouldReset: false, reason: 'storm_cap', fails };
  }
  return { shouldReset: true, reason: 'reset', fails };
}

/**
 * Record a persistent decrypt failure for a conversation and decide whether to
 * perform a session reset now. When it returns shouldReset=true, the caller
 * should purge the ratchet + rotate the SPK, then call `recordReset`.
 */
export function noteFailureAndDecideReset(convId: string, now: number = Date.now()): ResetDecision {
  if (state.size > MAX_ENTRIES) {
    const oldest = state.keys().next().value;
    if (oldest !== undefined) state.delete(oldest);
  }
  const entry = state.get(convId);
  const decision = decideReset(entry, now);

  const next: ResetEntry = entry
    ? { ...entry, fails: decision.fails, resetsAt: prune(entry.resetsAt, now) }
    : { fails: decision.fails, resetsAt: [], lastResetAt: 0 };
  state.set(convId, next);

  return decision;
}

/** Record that a reset was actually performed for a conversation. */
export function recordReset(convId: string, now: number = Date.now()): void {
  const entry = state.get(convId) ?? { fails: 0, resetsAt: [], lastResetAt: 0 };
  entry.resetsAt = [...prune(entry.resetsAt, now), now];
  entry.lastResetAt = now;
  entry.fails = 0; // start counting again toward the next potential reset
  state.set(convId, entry);
}

/** Clear reset accounting for a conversation after a successful decrypt. */
export function clearSessionReset(convId: string): void {
  state.delete(convId);
}

/** Test helper. */
export function _resetSessionResetTracker(): void {
  state.clear();
}
