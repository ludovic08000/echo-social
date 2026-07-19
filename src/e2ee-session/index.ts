/**
 * Small public façade shared by Aegis routing and identifiers.
 */
export * from './types';
export { safeUUID, shortId } from './safeUuid';
export {
  selfDeviceId,
  isSelfDeviceIdTemporary,
  listDevicesForUser,
  listFanoutTargets,
} from './deviceRegistry';
export { listKnownSessionIds } from '@/lib/crypto/deviceRatchet';
