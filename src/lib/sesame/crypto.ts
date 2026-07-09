/**
 * Sesame crypto facade.
 *
 * Keeps the protocol administration surface in one folder while preserving
 * the existing primitive modules in `src/lib/crypto`.
 */
export {
  RATCHET_PREFIX_V4,
  RATCHET_PREFIX_V5,
  clearAllDeviceSessions,
  establishDeviceSession,
  getSessionPeerSpkId,
  invalidateDeviceSession,
  listKnownSessionIds,
  ratchetDecrypt,
  ratchetEncrypt,
} from '@/lib/crypto/deviceRatchet';

export {
  fetchPrekeyBundleForDevice,
  peekDeviceSignedPrekey,
  x3dhInitiate,
  x3dhRespondForDevice,
} from '@/lib/crypto/x3dh';

export {
  validateInboundSecureEnvelope,
  wrapOutboundSecureMessage,
} from '@/lib/crypto/secureMessagePipeline';

export {
  loadPlaintext,
  loadPlaintextForCiphertext,
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';

export {
  verifyLatestTransparencyEpoch,
  type TransparencyEpochVerification,
} from '@/lib/crypto/transparencyLog';
