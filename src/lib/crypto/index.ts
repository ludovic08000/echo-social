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
export { resolveUserIdentity, type IdentityRecoveryMode } from './identityRecovery';

export {
  createSecureBackupVault,
  restoreSecureBackupVault,
  hasSecureBackupVault,
  type CreatedSecureBackupVault,
  type SecureBackupVaultPayload,
} from './secureBackupVault';

export {
  registerPasskeyForBackupVault,
  verifyPasskeyBeforeVaultRestore,
  hasLocalPasskeyVaultAlias,
} from './passkeyVault';

export {
  rotateEncryptedBackupVault,
  ensureBackupRotation,
} from './backupRotation';

export {
  ensureSecurityEpoch,
  bumpSecurityEpoch,
  getLocalSecurityEpoch,
  attachEpochToEnvelope,
  isEnvelopeEpochStale,
} from './securityEpoch';

export {
  createEpochBoundEnvelope,
  assertEnvelopeEpochValid,
} from './epochEnvelope';

export {
  createSealedSenderEnvelope,
} from './sealedSender';

export {
  issueSenderCertificate,
  fetchSenderCertificate,
  isSenderCertificateExpired,
} from './senderCertificate';

export {
  publishCurrentDevice,
  fetchActiveDevices,
  revokeCurrentDevice,
  getOrCreateCurrentDeviceId,
} from './deviceList';

export {
  publishSignedDeviceManifest,
  fetchSignedDeviceManifest,
} from './deviceManifest';

export {
  createEncryptedDeviceTransferPackage,
  openEncryptedDeviceTransferPackage,
} from './deviceTransfer';

export {
  assertNotReplay,
  isReplay,
  markReplaySeen,
} from './replayGuard';

export {
  clearAllRatchetSessions,
  clearConversationRatchetSession,
  startSessionInvalidationWatcher,
} from './sessionInvalidation';

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
  fetchTransparencyLog,
  appendTransparencyLog,
  verifyLatestTransparencyEpoch,
  type TransparencyEventType,
  type TransparencyEpochVerification,
} from './transparencyLog';

export { fetchPrekeyBundle } from './x3dhBundleRouter';

export {
  x3dhInitiate,
  x3dhRespond,
  generateAndUploadSignedPrekey,
  refreshSignedPrekeyIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  isPQXDHAvailable,
  type X3DHPrekeyBundle,
  type X3DHResult,
  type X3DHInitialMessage,
} from './x3dh';
