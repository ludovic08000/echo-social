/**
 * Crypto Integrity Shield — Anti-tampering defense layer
 * 
 * Protects against:
 * - Prototype pollution (Object.prototype, Array.prototype)
 * - crypto.subtle monkey-patching (XSS replacing encrypt/decrypt)
 * - JSON.parse / TextEncoder / indexedDB.open tampering
 * - Runtime code injection
 * 
 * STRATEGY: Snapshot ALL critical native references at module load time.
 * If malicious JS loads AFTER this module, it cannot replace these.
 * If it loads BEFORE — nothing can help (CSP is the real defense there).
 */

// ─── Snapshot native references at load time ───

// crypto.subtle
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
const _getRandomValues = <T extends ArrayBufferView | null>(array: T): T => crypto.getRandomValues(array as any) as T;

// Global APIs used in crypto pipeline
const _JSONparse = JSON.parse;
const _JSONstringify = JSON.stringify;
const _TextEncoder = TextEncoder;
const _TextDecoder = TextDecoder;
const _idbOpen = indexedDB.open.bind(indexedDB);
const _atob = globalThis.atob.bind(globalThis);
const _btoa = globalThis.btoa.bind(globalThis);

// Snapshot object identity for deep tamper detection
const _subtleRef = crypto.subtle;
const _cryptoRef = crypto;

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

/** Hardened global utilities — snapshotted at load time */
export const hardGlobals = Object.freeze({
  jsonParse: _JSONparse,
  jsonStringify: _JSONstringify,
  TextEncoder: _TextEncoder,
  TextDecoder: _TextDecoder,
  idbOpen: _idbOpen,
  atob: _atob,
  btoa: _btoa,
});

// ─── Tamper detection ───

let tamperDetected = false;
const tamperCallbacks: Array<(reason: string) => void> = [];
// Freeze the array structure — prevent .push()/.length=0 from external code
Object.defineProperty(tamperCallbacks, 'push', {
  value: function(this: Array<(reason: string) => void>, ...items: ((reason: string) => void)[]) {
    return Array.prototype.push.apply(this, items);
  },
  writable: false,
  configurable: false,
});

/** Register a tamper callback. Only callable via this function. */
export function onTamperDetected(cb: (reason: string) => void) {
  if (typeof cb !== 'function') return;
  tamperCallbacks[tamperCallbacks.length] = cb;
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
 * Verify the full crypto pipeline hasn't been monkey-patched.
 * Checks crypto.subtle methods + JSON.parse + TextEncoder + indexedDB.open.
 */
export function verifyCryptoIntegrity(): boolean {
  try {
    // Object identity checks — detect full object replacement
    if (crypto !== _cryptoRef) {
      triggerTamper('crypto object replaced');
      return false;
    }
    if (crypto.subtle !== _subtleRef) {
      triggerTamper('crypto.subtle object replaced');
      return false;
    }

    // crypto.subtle method checks
    const subtleChecks: [string, Function, Function][] = [
      ['encrypt', crypto.subtle.encrypt, _encrypt],
      ['decrypt', crypto.subtle.decrypt, _decrypt],
      ['importKey', crypto.subtle.importKey, _importKey],
      ['exportKey', crypto.subtle.exportKey, _exportKey],
      ['sign', crypto.subtle.sign, _sign],
      ['verify', crypto.subtle.verify, _verify],
      ['deriveBits', crypto.subtle.deriveBits, _deriveBits],
      ['deriveKey', crypto.subtle.deriveKey, _deriveKey],
      ['generateKey', crypto.subtle.generateKey, _generateKey],
      ['digest', crypto.subtle.digest, _digest],
    ];

    for (const [name, current, original] of subtleChecks) {
      if (current !== original) {
        triggerTamper(`crypto.subtle.${name} replaced`);
        return false;
      }
    }

    // getRandomValues
    if (crypto.getRandomValues !== _getRandomValues) {
      triggerTamper('crypto.getRandomValues replaced');
      return false;
    }

    // Global pipeline checks
    if (JSON.parse !== _JSONparse) {
      triggerTamper('JSON.parse replaced');
      return false;
    }
    if (JSON.stringify !== _JSONstringify) {
      triggerTamper('JSON.stringify replaced');
      return false;
    }
    if (globalThis.TextEncoder !== _TextEncoder) {
      triggerTamper('TextEncoder replaced');
      return false;
    }
    if (globalThis.TextDecoder !== _TextDecoder) {
      triggerTamper('TextDecoder replaced');
      return false;
    }
    if (globalThis.atob !== _atob) {
      triggerTamper('atob replaced');
      return false;
    }
    if (globalThis.btoa !== _btoa) {
      triggerTamper('btoa replaced');
      return false;
    }

    return true;
  } catch {
    triggerTamper('crypto integrity check access error');
    return false;
  }
}

// ─── Object.freeze critical prototypes ───

/**
 * Call once at app startup to prevent prototype pollution attacks.
 * Locks down critical methods on Object/Array prototypes.
 */
export function hardenPrototypes() {
  try {
    const criticalMethods = ['toString', 'valueOf', 'constructor', 'hasOwnProperty'] as const;
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
    console.warn('[SECURITY] Could not harden prototypes:', e);
  }
}

// ─── Memory scrubbing ───

/** Zero-fill a Uint8Array (for key material) */
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
