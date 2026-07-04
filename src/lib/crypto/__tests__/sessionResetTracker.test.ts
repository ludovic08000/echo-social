import { describe, it, expect, beforeEach } from 'vitest';
import {
  decideReset,
  noteFailureAndDecideReset,
  recordReset,
  clearSessionReset,
  _resetSessionResetTracker,
  FAIL_THRESHOLD,
  RESET_COOLDOWN_MS,
  MAX_RESETS_PER_WINDOW,
} from '../sessionResetTracker';

describe('decideReset (pure)', () => {
  it('stays below threshold for the first failures', () => {
    const d = decideReset(undefined, 1000);
    expect(d.shouldReset).toBe(false);
    expect(d.reason).toBe('below_threshold');
    expect(d.fails).toBe(1);
  });

  it('resets once the threshold is reached with no prior reset', () => {
    const entry = { fails: FAIL_THRESHOLD - 1, resetsAt: [], lastResetAt: 0 };
    const d = decideReset(entry, 1000);
    expect(d.fails).toBe(FAIL_THRESHOLD);
    expect(d.shouldReset).toBe(true);
    expect(d.reason).toBe('reset');
  });

  it('holds off during the cooldown after a recent reset', () => {
    const now = 100_000;
    const entry = { fails: FAIL_THRESHOLD, resetsAt: [now - 1000], lastResetAt: now - 1000 };
    const d = decideReset(entry, now);
    expect(d.shouldReset).toBe(false);
    expect(d.reason).toBe('cooldown');
  });
});

describe('noteFailureAndDecideReset + recordReset', () => {
  beforeEach(() => _resetSessionResetTracker());

  it('triggers a reset only after FAIL_THRESHOLD failures', () => {
    const conv = 'conv-threshold';
    let now = 0;
    let last;
    for (let i = 0; i < FAIL_THRESHOLD; i++) {
      last = noteFailureAndDecideReset(conv, now);
      now += 1000;
    }
    expect(last!.shouldReset).toBe(true);
  });

  it('enforces the cooldown between resets', () => {
    const conv = 'conv-cooldown';
    let now = 0;
    for (let i = 0; i < FAIL_THRESHOLD; i++) { noteFailureAndDecideReset(conv, now); now += 1000; }
    recordReset(conv, now);

    // After a reset, the fail counter restarts. Accumulate up to the threshold
    // again while still inside the cooldown — the failure that reaches the
    // threshold must be blocked by the cooldown, not trigger another reset.
    let last;
    for (let i = 0; i < FAIL_THRESHOLD; i++) {
      last = noteFailureAndDecideReset(conv, now + 500 + i);
    }
    expect(last!.shouldReset).toBe(false);
    expect(last!.reason).toBe('cooldown');

    // After the cooldown elapses, a reset is allowed again.
    let after = now + RESET_COOLDOWN_MS + 1;
    let d2;
    for (let i = 0; i < FAIL_THRESHOLD; i++) { d2 = noteFailureAndDecideReset(conv, after); after += 1000; }
    expect(d2!.shouldReset).toBe(true);
  });

  it('caps resets within the window (anti-storm)', () => {
    const conv = 'conv-storm';
    let now = 0;
    // Perform MAX_RESETS_PER_WINDOW resets, each after cooldown.
    for (let r = 0; r < MAX_RESETS_PER_WINDOW; r++) {
      for (let i = 0; i < FAIL_THRESHOLD; i++) { noteFailureAndDecideReset(conv, now); now += 1000; }
      const d = noteFailureAndDecideReset(conv, now);
      // reach threshold cleanly then record
      recordReset(conv, now);
      now += RESET_COOLDOWN_MS + 1;
    }
    // One more round: cooldown satisfied, but the window cap should block it.
    let d3;
    for (let i = 0; i < FAIL_THRESHOLD; i++) { d3 = noteFailureAndDecideReset(conv, now); now += 1000; }
    expect(d3!.shouldReset).toBe(false);
    expect(d3!.reason).toBe('storm_cap');
  });

  it('clearSessionReset resets the failure count', () => {
    const conv = 'conv-clear';
    noteFailureAndDecideReset(conv, 0);
    noteFailureAndDecideReset(conv, 1000);
    clearSessionReset(conv);
    const d = noteFailureAndDecideReset(conv, 2000);
    expect(d.fails).toBe(1);
    expect(d.shouldReset).toBe(false);
  });

  it('tracks conversations independently', () => {
    const a = noteFailureAndDecideReset('conv-a', 0);
    const b = noteFailureAndDecideReset('conv-b', 0);
    expect(a.fails).toBe(1);
    expect(b.fails).toBe(1);
  });
});
