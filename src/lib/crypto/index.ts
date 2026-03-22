/**
 * ForSure E2EE - Public API v2
 * 
 * X25519 + Ed25519 + AES-256-GCM + HKDF-SHA-256
 * Double Ratchet + Hybrid Post-Quantum Ready (Kyber768)
 */

// Legacy single-key encryption (for fallback / Zeus / group bootstrap)
export {
  encryptMessage,
  decryptMessage,
  establishSession,
  rotateSessionKey,
  needsKeyRotation,
  isEncryptedMessage,
  type EncryptedEnvelope,
} from './e2ee';

// Double Ratchet (primary protocol for 1:1 DMs)
export {
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
  type RatchetState,
  type RatchetEnvelope,
} from './ratchet';

// KDF chains
export { kdfChainStep, kdfRootStep } from './kdfChain';

// Key management
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

// Anti-exfiltration rate limiter
export {
  cryptoRateCheck,
  isCryptoLocked,
  onCryptoViolation,
  resetCryptoRateLimits,
} from './rateLimiter';
