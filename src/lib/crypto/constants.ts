/**
 * ForSure E2EE Constants
 * Hybrid Post-Quantum Ready Encryption System
 * 
 * Primitives used by the surrounding Aegis identity/storage layer:
 *   Session engine: Libsignal PQXDH + Double Ratchet
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

// IndexedDB — only Aegis account/device identity material is active here.
export const DB_NAME = 'forsure-e2ee';
export const DB_VERSION = 6;
export const STORE_KEYS = 'identity-keys';

// Invariant Libsignal : ces stores appartenaient aux anciens moteurs maison.
// Ils sont supprimés pendant l'upgrade, sans toucher au store d'identité actif.
export const LEGACY_E2EE_OBJECT_STORES = [
  'session-keys',
  'pre-keys',
  'encrypted-outbox',
] as const;
