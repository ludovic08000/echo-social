/**
 * ForSure E2EE - Public API
 * 
 * Hybrid Post-Quantum Ready Encryption
 * ECDH-P384 + AES-256-GCM + ECDSA-P384 + HKDF-SHA384
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
