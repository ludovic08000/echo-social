/**
 * ForSure E2EE - Public API v2
 * 
 * X25519 + Ed25519 + AES-256-GCM + HKDF-SHA-256
 * Hybrid Post-Quantum Ready (Kyber768)
 */

export {
  encryptMessage,
  decryptMessage,
  establishSession,
  rotateSessionKey,
  needsKeyRotation,
  isEncryptedMessage,
  type EncryptedEnvelope,
} from './e2ee';

export {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  loadSessionKey,
  saveSessionKey,
  deleteSessionKey,
  incrementSessionMessageCount,
  wipeAllKeys,
  type IdentityKeyPair,
  type SessionKey,
} from './keyManager';

export {
  PROTOCOL_VERSION,
  CLASSICAL_KEM_ID,
  PQ_KEM_ID,
} from './constants';
