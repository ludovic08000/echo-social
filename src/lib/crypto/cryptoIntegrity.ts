/**
 * Crypto Integrity Shield — Anti-tampering defense layer
 *
 * Protects against:
 * - crypto.subtle monkey-patching
 * - JSON.parse / TextEncoder / indexedDB.open tampering
 * - runtime replacement of critical crypto dependencies
 *
 * STRATEGY: snapshot native references at module load time. Bound helpers are
 * used for calls, while integrity checks compare against the original unbound
 * references. Comparing native methods to .bind() wrappers would always report
 * a false tamper event.
 */

// ─── Snapshot native references at load time ───

// crypto.subtle native references used for integrity comparisons
const _subtle = crypto.subtle;
const _generateKeyNative = _subtle.generateKey;
const _importKeyNative = _subtle.importKey;
const _exportKeyNative = _subtle.exportKey;
const _encryptNative = _subtle.encrypt;
const _decryptNative = _subtle.decrypt;
const _deriveBitsNative = _subtle.deriveBits;
const _deriveKeyNative = _subtle.deriveKey;
const _signNative = _subtle.sign;
const _verifyNative = _subtle.verify;
const _digestNative = _subtle.digest;
const _getRandomValuesNative = crypto.getRandomValues;

// Bound call helpers preserve the correct receiver.
const _generateKey = _generateKeyNative.bind(_subtle);
const _importKey = _importKeyNative.bind(_subtle);
const _exportKey = _exportKeyNative.bind(_subtle);
const _encrypt = _encryptNative.bind(_subtle);
const _decrypt = _decryptNative.bind(_subtle);
const _deriveBits = _deriveBitsNative.bind(_subtle);
const _deriveKey = _deriveKeyNative.bind(_subtle);
const _sign = _signNative.bind(_subtle);
const _verify = _verifyNative.bind(_subtle);
const _digest = _digestNative.bind(_subtle);
const _getRandomValues = <T extends ArrayBufferView | null>(array: T): T =>
  _getRandomValuesNative.call(crypto, array) as T;

// Global APIs used in crypto pipeline
const _JSONparse = JSON.parse;
const _JSONstringify = JSON.stringify;
const _TextEncoder = TextEncoder;
const _TextDecoder = TextDecoder;
const _idbOpenNative = indexedDB.open;
const _idbOpen = _idbOpenNative.bind(indexedDB);
const _atobNative = globalThis.atob;
const _btoaNative = globalThis.btoa;
const _atob = _atobNative.bind(globalThis);
const _btoa = _btoaNative.bind(globalThis);

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

/** Hardened global utilities — snapshotted references */
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

Object.defineProperty(tamperCallbacks, 'push', {
  value: function (this: Array<(reason: string) => void>, ...items: ((reason: string) => void)[]) {
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
  if (tamperDetected) return;
  tamperDetected = true;
  console.error(`[SECURITY] 🚨 TAMPER DETECTED: ${reason}`);
  for (const cb of tamperCallbacks) {
    try {
      cb(reason);
    } catch {}
  }
}

export function isTampered(): boolean {
  return tamperDetected;
}

/**
 * Verify the crypto pipeline has not been monkey-patched.
 * Native methods are compared with their original native references, never
 * with bound wrappers used to invoke them.
 */
export function verifyCryptoIntegrity(): boolean {
  try {
    if (crypto !== _cryptoRef) {
      triggerTamper('crypto object replaced');
      return false;
    }
    if (crypto.subtle !== _subtleRef) {
      triggerTamper('crypto.subtle object replaced');
      return false;
    }

    const subtleChecks: Array<[string, unknown, unknown]> = [
      ['encrypt', crypto.subtle.encrypt, _encryptNative],
      ['decrypt', crypto.subtle.decrypt, _decryptNative],
      ['importKey', crypto.subtle.importKey, _importKeyNative],
      ['exportKey', crypto.subtle.exportKey, _exportKeyNative],
      ['sign', crypto.subtle.sign, _signNative],
      ['verify', crypto.subtle.verify, _verifyNative],
      ['deriveBits', crypto.subtle.deriveBits, _deriveBitsNative],
      ['deriveKey', crypto.subtle.deriveKey, _deriveKeyNative],
      ['generateKey', crypto.subtle.generateKey, _generateKeyNative],
      ['digest', crypto.subtle.digest, _digestNative],
    ];

    for (const [name, current, original] of subtleChecks) {
      if (current !== original) {
        triggerTamper(`crypto.subtle.${name} replaced`);
        return false;
      }
    }

    if (crypto.getRandomValues !== _getRandomValuesNative) {
      triggerTamper('crypto.getRandomValues replaced');
      return false;
    }

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
    if (indexedDB.open !== _idbOpenNative) {
      triggerTamper('indexedDB.open replaced');
      return false;
    }
    if (globalThis.atob !== _atobNative) {
      triggerTamper('atob replaced');
      return false;
    }
    if (globalThis.btoa !== _btoaNative) {
      triggerTamper('btoa replaced');
      return false;
    }

    return true;
  } catch {
    triggerTamper('crypto integrity check access error');
    return false;
  }
}

// ─── Targeted hardening ───

/**
 * Lock only the critical Object.prototype methods used by the crypto pipeline.
 * Do not freeze complete global prototypes: framework and SDK internals may
 * legitimately install or patch unrelated properties.
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

/** Zero-fill a Uint8Array containing key material. */
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
