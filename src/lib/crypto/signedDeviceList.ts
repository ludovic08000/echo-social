/**
 * Transitional import bridge only.
 *
 * There is no signed-device-list authority behind this module anymore. All
 * reads and trust decisions are delegated to the canonical user_devices
 * registry. Delete this bridge once the remaining import sites have moved to
 * canonicalDeviceRegistry.
 */
export {
  fetchVerifiedDeviceIdentity,
  fetchVerifiedDeviceList,
  fetchTrustedDeviceList,
  type CanonicalRoutableDevice as SignedDeviceEntry,
} from './canonicalDeviceRegistry';
