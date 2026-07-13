/**
 * ForSure E2EE Constants
 * Hybrid Post-Quantum Ready Encryption System
 * 
 * Primitives (Signal-grade):
 *   Key Agreement: X3DH (Extended Triple Diffie-Hellman) / PQXDH (future)
 *   Key Exchange:  X25519 (Curve25519 ECDH)
 *   Signatures:    Ed25519
 *   Encryption:    AES-256-GCM
 *   Derivation:    HKDF-SHA-256
 *   Ratchet:       Double Ratchet (DH + symmetric KDF chains)
 */

// X25519 key exchange (same as Signal)
export const KX_ALGO = 'X25519';
export const KX_KEY_PARAMS: EcKeyGenParams = {
  name: 'X25519',
} as any; // Web Crypto types lag behind spec

// Ed25519 signing (same as Signal)
export const SIG_ALGO = 'Ed25519';
export const SIG_KEY_PARAMS: EcKeyGenParams = {
  name: 'Ed25519',
} as any;

// AES-256-GCM for message encryption
export const AES_ALGO = 'AES-GCM';
export const AES_KEY_LENGTH = 256;
export const IV_LENGTH = 12; // 96-bit IV (NIST recommended)
export const TAG_LENGTH = 128; // 128-bit auth tag

// HKDF for key derivation (SHA-256 like Signal)
export const HKDF_HASH = 'SHA-256';
export const HKDF_SALT_LENGTH = 32;

// Key rotation
export const KEY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const MAX_MESSAGES_PER_KEY = 500;

// IndexedDB — v5 adds the encrypted local outbox without deleting E2EE keys.
export const DB_NAME = 'forsure-e2ee';
export const DB_VERSION = 5;
export const STORE_KEYS = 'identity-keys';
export const STORE_SESSION = 'session-keys';
export const STORE_PREKEYS = 'pre-keys';
export const STORE_OUTBOX = 'encrypted-outbox';

// Protocol version (bump = breaking change)
//   v1 — legacy P-384 envelopes (read-only)
//   v2 — X25519 + Ed25519, no AAD on AES-GCM (still readable for migration)
//   v3 — AES-GCM AAD = "FORSURE-AD-v3|" || IKa || IKb (Signal X3DH §3.3 binding)
//   v4 — Signal Double Ratchet rev.4 §3.4 conformance: AAD = id_AD || canonical(header)
//        so the header (DH pub, n, pn) is cryptographically bound to ciphertext.
//        Decrypt accepts v2, v3, and v4 transparently.
export const PROTOCOL_VERSION = 4;

/** Domain-separation prefix used inside Associated Data of v3+ ratchet envelopes. */
export const AD_PREFIX_V3 = 'FORSURE-AD-v3|';
/** Header-binding prefix for v4 envelopes (Signal Double Ratchet §3.4). */
export const AD_HEADER_PREFIX_V4 = 'FORSURE-HDR-v4|';

/** Double Ratchet skipped message keys limits (Signal §2.6 + DoS protection). */
export const RATCHET_MAX_SKIP = 1000;
export const RATCHET_MAX_SKIPPED_CACHE = 2000;
/**
 * Skipped message keys TTL.
 * Lot A3: tightened from 7 days → 24 hours (audit recommendation).
 * Reduces the window where a device-compromise leaks historical messages.
 * Override via `localStorage.setItem('e2eeStrictSkippedTtl','false')` to keep 7d.
 */
export const RATCHET_SKIPPED_TTL_MS = (() => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('e2eeStrictSkippedTtl') === 'false') {
      return 7 * 24 * 60 * 60 * 1000;
    }
  } catch { /* SSR / locked storage */ }
  return 24 * 60 * 60 * 1000;
})();

// KEM identifiers
export const PQ_KEM_ID = 'HYBRID-X25519-KYBER768';
export const CLASSICAL_KEM_ID = 'X25519';