/**
 * Public entry point for the e2ee-session façade.
 *
 * Import-safe: no top-level side effects. Call `wirePendingQueue()` once at
 * app startup if you want background retry of out-of-order envelopes.
 */
export * from './types';
export { safeUUID, shortId } from './safeUuid';
export {
  selfDeviceId,
  isSelfDeviceIdTemporary,
  listDevicesForUser,
  listFanoutTargets,
} from './deviceRegistry';
export {
  makeSessionId,
  describeSession,
  markSessionUsed,
  archiveSession,
  getCachedPeerSpkId,
} from './sessionStore';
export { encryptForDevice } from './sessionManager';
export { hasPrekeyBundle } from './sessionBootstrap';
export {
  legacyDecryptDeviceCopy,
  legacyDecryptByMessageId,
  isKnownLegacyFormat,
} from './legacyDecryptRouter';
export { tryEveryRatchetSession } from './fallbackDecrypt';
export { routeIncoming, wirePendingQueue } from './messageRouter';
export { pendingMessageQueue } from './pendingMessageQueue';
export { listKnownSessionIds } from '@/lib/crypto/deviceRatchet';
