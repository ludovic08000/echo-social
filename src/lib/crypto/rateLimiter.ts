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
  encrypt:     { max: 120, windowMs: 10_000 },  // 120 encrypts per 10s
  decrypt:     { max: 500, windowMs: 10_000 },  // 500 decrypts per 10s (loading full history)
  sign:        { max: 120, windowMs: 10_000 },  // mirrors encrypt
  // deriveBits removed: internal key derivation must never be blocked by rate limiter
  // — the encrypt/sign limits already protect against abuse
};

// Per-operation lockdown instead of global — decrypt overload must NOT block encrypt/send
const lockdownUntilMap = new Map<string, number>();
const LOCKDOWN_DURATION_MS = 5_000; // 5s lockdown (was 30s — too aggressive)
const WIPE_THRESHOLD = 3; // 3 lockdowns in 60s = auto-wipe (active attack)

const violationCallbacks: Array<(op: string, count: number) => void> = [];
const lockdownHistory: number[] = []; // timestamps of lockdowns

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
    
    // Track lockdown frequency for auto-wipe
    lockdownHistory.push(now);
    // Keep only last 60s
    while (lockdownHistory.length > 0 && now - lockdownHistory[0] > 60_000) {
      lockdownHistory.shift();
    }

    console.error(
      `[SECURITY] Crypto rate limit exceeded: ${operation} ` +
      `(${bucket.count}/${limit.max} in ${limit.windowMs}ms). ` +
      `Lockdown activated for ${LOCKDOWN_DURATION_MS / 1000}s. ` +
      `(${lockdownHistory.length}/${WIPE_THRESHOLD} lockdowns in 60s)`
    );

    // AUTO-WIPE: If 3+ lockdowns in 60s, this is an active attack
    if (lockdownHistory.length >= WIPE_THRESHOLD) {
      console.error('[SECURITY] 🚨 AUTO-WIPE TRIGGERED — suspected exfiltration attack');
      triggerAutoWipe();
    }

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
  lockdownHistory.length = 0;
}

// ─── Auto-wipe on sustained attack ───

const wipeCallbacks: Array<() => void> = [];

/** Register callback for auto-wipe event (e.g. wipeAllKeys + logout) */
export function onAutoWipe(cb: () => void) {
  wipeCallbacks.push(cb);
}

function triggerAutoWipe() {
  // Wipe all IndexedDB crypto stores
  try { indexedDB.deleteDatabase('forsure-e2ee'); } catch {}
  try { indexedDB.deleteDatabase('forsure-ratchet'); } catch {}
  try { indexedDB.deleteDatabase('forsure-pin-wrap'); } catch {}
  
  // Clear localStorage crypto data
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('forsure-')) keysToRemove.push(key);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch {}

  // Notify listeners (e.g. force logout)
  for (const cb of wipeCallbacks) {
    try { cb(); } catch {}
  }
}
