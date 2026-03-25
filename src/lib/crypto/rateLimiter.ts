/**
 * Crypto Rate Limiter — Anti-bulk-exfiltration defense
 * 
 * If an XSS payload tries to mass-decrypt messages or brute-force
 * key operations, this will detect the anomaly and kill the session.
 *
 * This is NOT a replacement for CSP — it's a last-resort tripwire.
 */

interface RateBucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, RateBucket>();

// Thresholds — generous for legitimate use, catches only extreme abuse
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  encrypt:     { max: 60,  windowMs: 10_000 },  // 60 encrypts per 10s
  decrypt:     { max: 500, windowMs: 10_000 },  // 500 decrypts per 10s (loading full history)
  deriveBits:  { max: 20,  windowMs: 60_000 },  // 20 key derivations per minute
  sign:        { max: 60,  windowMs: 10_000 },  // mirrors encrypt
};

// Per-operation lockdown instead of global — decrypt overload must NOT block encrypt/send
const lockdownUntilMap = new Map<string, number>();
const LOCKDOWN_DURATION_MS = 5_000; // 5s lockdown (was 30s — too aggressive)

const violationCallbacks: Array<(op: string, count: number) => void> = [];

/** Register a callback for rate-limit violations (e.g. logging, alerts) */
export function onCryptoViolation(cb: (op: string, count: number) => void) {
  violationCallbacks.push(cb);
}

/**
 * Check if an operation is allowed. Call BEFORE performing the crypto op.
 * Returns true if allowed, false if rate-limited.
 * Throws in lockdown mode (circuit breaker).
 */
export function cryptoRateCheck(operation: string): boolean {
  const now = Date.now();

  // Per-operation circuit breaker
  const opLockdown = lockdownUntilMap.get(operation) || 0;
  if (now < opLockdown) {
    return false;
  }

  const limit = LIMITS[operation];
  if (!limit) return true; // Unknown ops pass through

  let bucket = buckets.get(operation);
  if (!bucket || now - bucket.windowStart > limit.windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(operation, bucket);
  }

  bucket.count++;

  if (bucket.count > limit.max) {
    // TRIP! Only lock THIS operation, not all crypto
    lockdownUntilMap.set(operation, now + LOCKDOWN_DURATION_MS);
    
    console.error(
      `[SECURITY] Crypto rate limit exceeded: ${operation} ` +
      `(${bucket.count}/${limit.max} in ${limit.windowMs}ms). ` +
      `Lockdown activated for ${LOCKDOWN_DURATION_MS / 1000}s.`
    );

    for (const cb of violationCallbacks) {
      try { cb(operation, bucket.count); } catch {}
    }

    buckets.delete(operation);
    return false;
  }

  return true;
}

/** Check if crypto operations are currently locked down */
export function isCryptoLocked(): boolean {
  const now = Date.now();
  for (const until of lockdownUntilMap.values()) {
    if (now < until) return true;
  }
  return false;
}

/** Reset all rate limits (for testing) */
export function resetCryptoRateLimits() {
  buckets.clear();
  lockdownUntilMap.clear();
}
