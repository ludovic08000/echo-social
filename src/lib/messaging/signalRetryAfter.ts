// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Adapted for Sesame on 2026-07-16 from Signal Desktop's
// ts/util/parseRetryAfter.std.ts. This version accepts both delta-seconds and
// an RFC 7231 HTTP-date because browser fetch responses can expose either.

const SECOND_MS = 1_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MINIMUM_RETRY_AFTER_MS = 1_000;

/** Parses Retry-After into milliseconds, or returns undefined when invalid. */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value * SECOND_MS : undefined;
  }
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim();
  if (!normalized) return undefined;

  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? seconds * SECOND_MS : undefined;
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

export function parseRetryAfterWithDefault(
  value: unknown,
  defaultValue: number = DEFAULT_RETRY_AFTER_MS,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(defaultValue) || defaultValue < 0) {
    throw new RangeError('defaultValue must be a finite non-negative number');
  }
  const parsed = parseRetryAfter(value, now);
  return Math.max(parsed ?? defaultValue, MINIMUM_RETRY_AFTER_MS);
}
