/**
 * ForSure E2EE - Public API v2
 * 
 * X25519 + Ed25519 + AES-256-GCM + HKDF-SHA-256
 * Double Ratchet + Hybrid Post-Quantum Ready (Kyber768)
 */

export {
  encryptMessage,
  decryptMessage,
  isEncryptedMessage,
  establishSession,
  type EncryptedEnvelope,
} from './e2ee';

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

export { kdfChainStep, kdfChainStepExportable, kdfRootStep } from './kdfChain';

export { getOrCreateIdentityKeys } from './keyManagerSafe';

export {
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

export {
  cryptoRateCheck,
  isCryptoLocked,
  onCryptoViolation,
  resetCryptoRateLimits,
  onAutoWipe,
} from './rateLimiter';

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

export {
  wrapKeysWithPin,
  unwrapKeysWithPin,
  hasWrappedKeys,
  deleteWrappedKeys,
} from './pinWrap';

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
