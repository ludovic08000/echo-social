import * as legacy from '../messaging/currentDevice';

export const setCurrentDeviceUserScope = legacy.setCurrentDeviceUserScope;
export const getDeviceFingerprint = legacy.getDeviceFingerprint;
export const getDeviceFingerprintCandidates = legacy.getDeviceFingerprintCandidates;
export const setCurrentDeviceId = legacy.setCurrentDeviceId;
export const adoptDeviceIdFromBackup = legacy.adoptDeviceIdFromBackup;
export const getCurrentDeviceId = legacy.getCurrentDeviceId;
export const isDeviceIdTemporary = legacy.isDeviceIdTemporary;
export const hydrateDeviceId = legacy.hydrateDeviceId;
export const getCurrentDeviceLabel = legacy.getCurrentDeviceLabel;
export const getCurrentPlatform = legacy.getCurrentPlatform;

const EXPLICIT_ROTATION_REASONS = new Set([
  'explicit-user-reset',
  'blocked-recovery-device',
  'fresh-install-without-stable-id',
  // A revoked DeviceID is permanently retired. After the account identity has
  // been unlocked with the PIN, the same physical installation must enroll as
  // a new device instead of clearing revoked_at on the old row.
  'revoked-reenrollment-after-pin',
]);

/**
 * Device IDs are immutable routing identities. Automatic rotation is forbidden.
 * A revoked row is the one exception that requires a NEW routing identity, but
 * only from the explicit post-PIN reenrollment flow.
 */
export function rotateCurrentDeviceId(reason = 'automatic-request'): string {
  const current = legacy.getCurrentDeviceId();
  if (!EXPLICIT_ROTATION_REASONS.has(reason)) {
    console.error('[DeviceManager] automatic DeviceID rotation blocked', {
      reason,
      deviceId: current.slice(0, 8),
    });
    try {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-device-approval-required', {
        detail: {
          source: 'device-manager',
          deviceId: current,
          code: 'STABLE_DEVICE_REQUIRES_REAPPROVAL',
          reason,
        },
      }));
    } catch {}
    return current;
  }

  console.warn('[DeviceManager] explicit DeviceID reset allowed', {
    reason,
    previous: current.slice(0, 8),
  });
  return legacy.rotateCurrentDeviceId(reason);
}
