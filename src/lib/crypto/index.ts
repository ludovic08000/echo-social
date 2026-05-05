/**
 * ForSure E2EE - Public API v2
 * 
 * X25519 + Ed25519 + AES-256-GCM + HKDF-SHA-256
 * Double Ratchet + Hybrid Post-Quantum Ready (Kyber768)
 */

// NOTE: Legacy single-key envelope helpers are still exported from './e2ee'
// for internal modules that need symmetric primitives (mediaEncrypt,
// callKeyEncrypt, accountKeyBackup). They are NOT used for messaging anymore.
export {
  encryptMessage,
  decryptMessage,
  isEncryptedMessage,
  establishSession,
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
  getRatchetReadiness,
  isRatchetReadyForEncrypt,
  isRatchetReadyForDecrypt,
  type RatchetState,
  type RatchetEnvelope,
  type RatchetReadiness,
} from './ratchet';

// KDF chains
export { kdfChainStep, kdfChainStepExportable, kdfRootStep } from './kdfChain';

// Key management
// NOTE: loadSessionKey/saveSessionKey/establishSession are kept for non-message
// flows that still rely on a per-conversation symmetric session
// (call key encryption, account key backup). Messaging itself uses Double
// Ratchet exclusively and never touches these helpers anymore.
export {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  loadSessionKey,
  saveSessionKey,
  deleteSessionKey,
  wipeAllKeys,
  wipeSessionKeys,
  exportAllSessionKeys,
  importAllSessionKeys,
  exportAllRatchetStates,
  importAllRatchetStates,
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
  onAutoWipe,
} from './rateLimiter';

// Integrity shield (anti-tampering)
export {
  hardCrypto,
  verifyCryptoIntegrity,
  isTampered,
  onTamperDetected,
  hardenPrototypes,
  startIntegrityMonitor,
  stopIntegrityMonitor,
  scrubBuffer,
} from './cryptoIntegrity';

// PIN wrapping (keys encrypted at rest)
export {
  wrapKeysWithPin,
  unwrapKeysWithPin,
  hasWrappedKeys,
  deleteWrappedKeys,
} from './pinWrap';

// X3DH key agreement (Signal spec)
export {
  x3dhInitiate,
  x3dhRespond,
  fetchPrekeyBundle,
  generateAndUploadSignedPrekey,
  refreshSignedPrekeyIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  isPQXDHAvailable,
  type X3DHPrekeyBundle,
  type X3DHResult,
  type X3DHInitialMessage,
} from './x3dh';
