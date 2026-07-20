// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Adapted for Aegis on 2026-07-16 from Signal Desktop's
// ts/util/exponentialBackoff.std.ts. Signal-specific assertion and duration
// helpers were replaced with dependency-free TypeScript equivalents.

const DEFAULT_BACKOFF_FACTOR = 1.9;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_FIRST_BACKOFFS_MS = [0, 190] as const;

export type ExponentialBackoffOptions = Readonly<{
  maxBackoffTime: number;
  multiplier: number;
  firstBackoffs: ReadonlyArray<number>;
}>;

export const AEGIS_BACKOFF_DEFAULTS: ExponentialBackoffOptions = Object.freeze({
  maxBackoffTime: DEFAULT_MAX_BACKOFF_MS,
  multiplier: DEFAULT_BACKOFF_FACTOR,
  firstBackoffs: DEFAULT_FIRST_BACKOFFS_MS,
});

function assertPositiveAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive 1-indexed integer');
  }
}

function assertValidOptions(options: ExponentialBackoffOptions): void {
  if (!Number.isFinite(options.maxBackoffTime) || options.maxBackoffTime < 0) {
    throw new RangeError('maxBackoffTime must be a finite non-negative number');
  }
  if (!Number.isFinite(options.multiplier) || options.multiplier <= 1) {
    throw new RangeError('multiplier must be a finite number greater than 1');
  }
  if (options.firstBackoffs.length === 0) {
    throw new RangeError('firstBackoffs must include at least one explicit delay');
  }
  if (options.firstBackoffs.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('firstBackoffs must contain finite non-negative delays');
  }
  const last = options.firstBackoffs.at(-1);
  if (options.firstBackoffs.length > 1 && (!last || last <= 0)) {
    throw new RangeError('the last explicit backoff must be positive');
  }
}

/**
 * Returns Signal's deterministic exponential delay for a 1-indexed attempt.
 * The default sequence starts at 0 ms, then 190 ms, and plateaus at 15 min.
 */
export function exponentialBackoffSleepTime(
  attempt: number,
  options: ExponentialBackoffOptions = AEGIS_BACKOFF_DEFAULTS,
): number {
  assertPositiveAttempt(attempt);
  assertValidOptions(options);

  const explicitCount = options.firstBackoffs.length;
  if (attempt - 1 < explicitCount) {
    return options.firstBackoffs[attempt - 1] ?? 0;
  }

  const lastExplicit = options.firstBackoffs.at(-1) ?? 0;
  return Math.min(
    options.maxBackoffTime,
    (lastExplicit / options.multiplier) * options.multiplier ** (attempt - explicitCount + 1),
  );
}

/** Returns the number of attempts whose cumulative delays cover a duration. */
export function exponentialBackoffMaxAttempts(
  desiredDurationMs: number,
  options: ExponentialBackoffOptions = AEGIS_BACKOFF_DEFAULTS,
): number {
  if (!Number.isFinite(desiredDurationMs) || desiredDurationMs < 1) {
    throw new RangeError('desiredDurationMs must be a finite number of at least 1 ms');
  }

  let attempts = 0;
  let total = 0;
  do {
    attempts += 1;
    total += exponentialBackoffSleepTime(attempts, options);
  } while (total < desiredDurationMs);

  return attempts;
}

/**
 * Full jitter prevents many clients from retrying simultaneously after an
 * outage. Pass a deterministic random function in tests.
 */
export function applyFullJitter(
  delayMs: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('delayMs must be a finite non-negative number');
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError('random must return a finite value between 0 and 1');
  }
  return Math.floor(delayMs * sample);
}

export type AegisRetryDelayOptions = Readonly<{
  attempt: number;
  retryAfterMs?: number;
  jitter?: boolean;
  random?: () => number;
  backoff?: ExponentialBackoffOptions;
}>;

/**
 * Computes a retry delay while respecting an authoritative server Retry-After.
 * Retry-After is never jittered or shortened.
 */
export function computeAegisRetryDelay({
  attempt,
  retryAfterMs,
  jitter = true,
  random = Math.random,
  backoff = AEGIS_BACKOFF_DEFAULTS,
}: AegisRetryDelayOptions): number {
  if (retryAfterMs !== undefined) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError('retryAfterMs must be a finite non-negative number');
    }
    return Math.ceil(retryAfterMs);
  }

  const baseDelay = exponentialBackoffSleepTime(attempt, backoff);
  return jitter ? applyFullJitter(baseDelay, random) : Math.ceil(baseDelay);
}
