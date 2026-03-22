/**
 * ForSure E2EE Constants
 * Hybrid Post-Quantum Ready Encryption System
 */

// ECDH key exchange parameters (classical layer)
export const ECDH_CURVE = 'P-384'; // NIST P-384 (stronger than Signal's X25519)
export const ECDH_KEY_PARAMS: EcKeyGenParams = {
  name: 'ECDH',
  namedCurve: ECDH_CURVE,
};

// ECDSA signing parameters
export const ECDSA_KEY_PARAMS: EcKeyGenParams = {
  name: 'ECDSA',
  namedCurve: ECDH_CURVE,
};

// AES-256-GCM for message encryption
export const AES_ALGO = 'AES-GCM';
export const AES_KEY_LENGTH = 256;
export const IV_LENGTH = 12; // 96-bit IV for AES-GCM (NIST recommended)
export const TAG_LENGTH = 128; // 128-bit authentication tag

// HKDF for key derivation
export const HKDF_HASH = 'SHA-384';
export const HKDF_SALT_LENGTH = 32;

// Key rotation
export const KEY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_MESSAGES_PER_KEY = 500; // Rotate after N messages

// IndexedDB
export const DB_NAME = 'forsure-e2ee';
export const DB_VERSION = 1;
export const STORE_KEYS = 'identity-keys';
export const STORE_SESSION = 'session-keys';
export const STORE_PREKEYS = 'pre-keys';

// Protocol version for forward compatibility
export const PROTOCOL_VERSION = 1;

// Post-quantum KEM identifier (hybrid envelope marker)
export const PQ_KEM_ID = 'HYBRID-ECDH-KYBER768';
export const CLASSICAL_KEM_ID = 'ECDH-P384';
