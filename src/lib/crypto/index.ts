/**
 * ForSure E2EE - API publique
 *
 * Invariant cryptographique : le protocole de messagerie est libsignal
 * exclusivement (X3DH/PQXDH + Double Ratchet côté libsignal). Aucune primitive
 * de session maison n'est exportée ici.
 */

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
  rotateEncryptedBackupVault,
  ensureBackupRotation,
} from './backupRotation';

export {
  publishCurrentDevice,
  fetchActiveDevices,
  revokeCurrentDevice,
  getOrCreateCurrentDeviceId,
} from './deviceList';

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

export { fetchTransparencyLog, appendTransparencyLog, type TransparencyEventType } from './transparencyLog';

export {
  LIBSIGNAL_WIRE_PREFIX,
  decodeLibsignalWire,
  encodeLibsignalWire,
} from './libsignalWire';
