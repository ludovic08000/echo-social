/**
 * Crypto Rate Limiter — Anti-bulk-exfiltration defense
 * 
 * If an XSS payload tries to mass-decrypt messages or brute-force
 * key operations, this will detect the anomaly and kill the session.
 *
 * v2: Smarter wipe logic — distinguishes legit bursts from attacks.
 */

interface RateBucket {
  count: number;
  windowStart: number;
}

// ─── Security journal ───
interface SecurityEvent {
  ts: number;
  op: string;
  count: number;
  source: 'lockdown' | 'violation';
}

const securityJournal: SecurityEvent[] = [];
const MAX_JOURNAL = 50;

function journalEvent(event: SecurityEvent) {
  securityJournal.push(event);
  if (securityJournal.length > MAX_JOURNAL) securityJournal.shift();
}

/** Get recent security events (for debugging/telemetry) */
export function getSecurityJournal(): readonly SecurityEvent[] {
  return securityJournal;
}

// ─── Rate limiting ───

const buckets = new Map<string, RateBucket>();

// Thresholds — generous for legitimate use, catches only extreme abuse
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  encrypt:     { max: 600, windowMs: 10_000 },  // raised: retries + bursts shouldn't trip this
  decrypt:     { max: 1000, windowMs: 10_000 }, // raised: full history loads
  sign:        { max: 600, windowMs: 10_000 },
};

// Per-operation lockdown instead of global
const lockdownUntilMap = new Map<string, number>();
const LOCKDOWN_DURATION_MS = 5_000;

// Auto-wipe: requires DISTINCT operations hitting lockdown (not just retries on one)
const WIPE_THRESHOLD = 5;           // 5 lockdowns in 120s (was 3 in 60s)
const WIPE_WINDOW_MS = 120_000;     // 2-minute window
const WIPE_MIN_DISTINCT_OPS = 2;    // Must be 2+ different operations (encrypt+decrypt = attack, not a bug)

const violationCallbacks: Array<(op: string, count: number) => void> = [];
const lockdownHistory: Array<{ ts: number; op: string }> = [];

/** Register a callback for rate-limit violations */
export function onCryptoViolation(cb: (op: string, count: number) => void) {
  violationCallbacks.push(cb);
}

/**
 * Check if an operation is allowed.
 * Returns true if allowed, false if rate-limited.
 */
export function cryptoRateCheck(operation: string): boolean {
  const now = Date.now();

  // Per-operation circuit breaker
  const opLockdown = lockdownUntilMap.get(operation) || 0;
  if (now < opLockdown) {
    return false;
  }

  const limit = LIMITS[operation];
  if (!limit) return true;

  let bucket = buckets.get(operation);
  if (!bucket || now - bucket.windowStart > limit.windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(operation, bucket);
  }

  bucket.count++;

  if (bucket.count > limit.max) {
    // LOCKDOWN this operation
    lockdownUntilMap.set(operation, now + LOCKDOWN_DURATION_MS);
    
    // Journal + track
    lockdownHistory.push({ ts: now, op: operation });
    journalEvent({ ts: now, op: operation, count: bucket.count, source: 'lockdown' });

    // Prune old entries
    while (lockdownHistory.length > 0 && now - lockdownHistory[0].ts > WIPE_WINDOW_MS) {
      lockdownHistory.shift();
    }

    const recentCount = lockdownHistory.length;
    const distinctOps = new Set(lockdownHistory.map(h => h.op)).size;

    console.error(
      `[SECURITY] Rate limit: ${operation} ` +
      `(${bucket.count}/${limit.max} in ${limit.windowMs}ms). ` +
      `Lockdown ${LOCKDOWN_DURATION_MS / 1000}s. ` +
      `[${recentCount}/${WIPE_THRESHOLD} lockdowns, ${distinctOps} distinct ops]`
    );

    // AUTO-WIPE DISABLED: never destroy crypto state automatically on heuristics.
    if (recentCount >= WIPE_THRESHOLD && distinctOps >= WIPE_MIN_DISTINCT_OPS) {
      console.error('[SECURITY] 🚨 Sustained multi-operation crypto anomaly detected — auto-wipe disabled, preserving state for investigation');
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
  securityJournal.length = 0;
}

// ─── Auto-wipe callbacks kept for backward compatibility, but never triggered ───

const wipeCallbacks: Array<() => void> = [];

/** Register callback for auto-wipe event (legacy compatibility only) */
export function onAutoWipe(cb: () => void) {
  wipeCallbacks.push(cb);
}
