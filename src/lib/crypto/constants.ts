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

// IndexedDB — schema repair version to restore missing stores without deleting identity keys
export const DB_NAME = 'forsure-e2ee';
export const DB_VERSION = 4;
export const STORE_KEYS = 'identity-keys';
export const STORE_SESSION = 'session-keys';
export const STORE_PREKEYS = 'pre-keys';

// Protocol version (bump = breaking change)
//   v1 — legacy P-384 envelopes (read-only)
//   v2 — X25519 + Ed25519, no AAD on AES-GCM (still readable for migration)
//   v3 — current: AES-GCM additionalData = "FORSURE-AD-v3|" || base64(IKa) || "|" || base64(IKb)
//        bound to X3DH identity keys (Signal X3DH §3.3). Decrypt accepts both v2 and v3.
export const PROTOCOL_VERSION = 3;

/** Domain-separation prefix used inside Associated Data of v3 ratchet envelopes (reserved). */
export const AD_PREFIX_V3 = 'FORSURE-AD-v3|';

// KEM identifiers
export const PQ_KEM_ID = 'HYBRID-X25519-KYBER768';
export const CLASSICAL_KEM_ID = 'X25519';
