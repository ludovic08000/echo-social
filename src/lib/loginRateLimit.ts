/**
 * Client-side login rate limiter
 * Prevents brute-force attempts by enforcing exponential backoff.
 */
const STORAGE_KEY = 'forsure-login-rl';
const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000; // 30s base
const MAX_LOCKOUT_MS = 15 * 60_000; // 15 min max

interface RateLimitState {
  attempts: number;
  lastAttempt: number;
  lockedUntil: number;
}

function getState(): RateLimitState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { attempts: 0, lastAttempt: 0, lockedUntil: 0 };
}

function setState(s: RateLimitState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/** Returns remaining lockout seconds, or 0 if allowed */
export function checkLoginAllowed(): number {
  const s = getState();
  const now = Date.now();

  // Auto-reset after 30 min of inactivity
  if (now - s.lastAttempt > 30 * 60_000) {
    setState({ attempts: 0, lastAttempt: 0, lockedUntil: 0 });
    return 0;
  }

  if (s.lockedUntil > now) {
    return Math.ceil((s.lockedUntil - now) / 1000);
  }
  return 0;
}

/** Record a failed login attempt, returns remaining lockout seconds or 0 */
export function recordFailedLogin(): number {
  const s = getState();
  const now = Date.now();
  s.attempts += 1;
  s.lastAttempt = now;

  if (s.attempts >= MAX_ATTEMPTS) {
    // Exponential backoff: 30s, 60s, 120s, ... capped at 15 min
    const exponent = Math.min(s.attempts - MAX_ATTEMPTS, 5);
    const lockoutMs = Math.min(BASE_LOCKOUT_MS * Math.pow(2, exponent), MAX_LOCKOUT_MS);
    s.lockedUntil = now + lockoutMs;
    setState(s);
    return Math.ceil(lockoutMs / 1000);
  }

  setState(s);
  return 0;
}

/** Reset after successful login */
export function resetLoginAttempts(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
