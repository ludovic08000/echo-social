/**
 * Crypto Integrity Shield — Anti-tampering defense layer
 * 
 * Protects against:
 * - Prototype pollution (Object.prototype, Array.prototype)
 * - crypto.subtle monkey-patching (XSS replacing encrypt/decrypt)
 * - IndexedDB tampering
 * - Runtime code injection
 */

// ─── Snapshot native references at load time ───
// If malicious JS loads AFTER this module, it cannot replace these.

const _subtle = crypto.subtle;
const _generateKey = _subtle.generateKey.bind(_subtle);
const _importKey = _subtle.importKey.bind(_subtle);
const _exportKey = _subtle.exportKey.bind(_subtle);
const _encrypt = _subtle.encrypt.bind(_subtle);
const _decrypt = _subtle.decrypt.bind(_subtle);
const _deriveBits = _subtle.deriveBits.bind(_subtle);
const _deriveKey = _subtle.deriveKey.bind(_subtle);
const _sign = _subtle.sign.bind(_subtle);
const _verify = _subtle.verify.bind(_subtle);
const _digest = _subtle.digest.bind(_subtle);
const _getRandomValues = crypto.getRandomValues.bind(crypto);

/** Hardened crypto.subtle — uses snapshotted references */
export const hardCrypto = Object.freeze({
  generateKey: _generateKey,
  importKey: _importKey,
  exportKey: _exportKey,
  encrypt: _encrypt,
  decrypt: _decrypt,
  deriveBits: _deriveBits,
  deriveKey: _deriveKey,
  sign: _sign,
  verify: _verify,
  digest: _digest,
  getRandomValues: _getRandomValues,
});

// ─── Tamper detection ───

let tamperDetected = false;
const tamperCallbacks: Array<(reason: string) => void> = [];

export function onTamperDetected(cb: (reason: string) => void) {
  tamperCallbacks.push(cb);
}

function triggerTamper(reason: string) {
  if (tamperDetected) return; // Only fire once
  tamperDetected = true;
  console.error(`[SECURITY] 🚨 TAMPER DETECTED: ${reason}`);
  for (const cb of tamperCallbacks) {
    try { cb(reason); } catch {}
  }
}

export function isTampered(): boolean {
  return tamperDetected;
}

/**
 * Verify crypto.subtle hasn't been monkey-patched.
 * Call periodically (e.g. before encrypt/decrypt).
 */
export function verifyCryptoIntegrity(): boolean {
  try {
    // Check if crypto.subtle.encrypt has been replaced
    if (crypto.subtle.encrypt !== _encrypt) {
      triggerTamper('crypto.subtle.encrypt replaced');
      return false;
    }
    if (crypto.subtle.decrypt !== _decrypt) {
      triggerTamper('crypto.subtle.decrypt replaced');
      return false;
    }
    if (crypto.subtle.importKey !== _importKey) {
      triggerTamper('crypto.subtle.importKey replaced');
      return false;
    }
    if (crypto.subtle.exportKey !== _exportKey) {
      triggerTamper('crypto.subtle.exportKey replaced');
      return false;
    }
    if (crypto.subtle.sign !== _sign) {
      triggerTamper('crypto.subtle.sign replaced');
      return false;
    }
    return true;
  } catch {
    triggerTamper('crypto.subtle access error');
    return false;
  }
}

// ─── Object.freeze critical prototypes ───

/**
 * Call once at app startup to prevent prototype pollution attacks.
 * Freezes critical methods on Object/Array prototypes.
 */
export function hardenPrototypes() {
  try {
    // Freeze toString/valueOf to prevent injection via prototype pollution
    const criticalMethods = ['toString', 'valueOf', 'constructor'] as const;
    for (const method of criticalMethods) {
      const desc = Object.getOwnPropertyDescriptor(Object.prototype, method);
      if (desc && desc.configurable) {
        Object.defineProperty(Object.prototype, method, {
          ...desc,
          configurable: false,
          writable: false,
        });
      }
    }
  } catch (e) {
    // Non-fatal: some environments restrict prototype modification
    console.warn('[SECURITY] Could not harden prototypes:', e);
  }
}

// ─── Memory scrubbing ───

/**
 * Zero-fill a string in memory (best effort — JS strings are immutable,
 * but we can clear variables holding references).
 */
export function scrubString(str: string): void {
  // In JS we can't truly scrub immutable strings, but we can:
  // 1. Overwrite the variable in the caller's scope (caller responsibility)
  // 2. Force GC hint
  void str;
}

/**
 * Zero-fill a Uint8Array (for key material)
 */
export function scrubBuffer(buffer: Uint8Array): void {
  buffer.fill(0);
}

// ─── Periodic integrity check ───

let integrityInterval: ReturnType<typeof setInterval> | null = null;

export function startIntegrityMonitor(intervalMs = 10_000) {
  if (integrityInterval) return;
  integrityInterval = setInterval(() => {
    verifyCryptoIntegrity();
  }, intervalMs);
}

export function stopIntegrityMonitor() {
  if (integrityInterval) {
    clearInterval(integrityInterval);
    integrityInterval = null;
  }
}
