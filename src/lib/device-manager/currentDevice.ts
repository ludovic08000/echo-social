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
  'fresh-install-without-stable-id',
  // Loss of the private device key is not an authorization revocation. The old
  // route is first marked unavailable, then a new cryptographic installation
  // is enrolled under the authenticated account session.
  'aegis-device-private-key-missing',
]);

/**
 * Device IDs are immutable routing identities. Automatic rotation is forbidden.
 * A revoked/rejected row has no rotation exception: it remains blocked until a
 * deliberate user action. Route-key loss is a separate health transition.
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
    } catch {
      // Browser event delivery is advisory; the rotation remains blocked.
    }
    return current;
  }

  console.warn('[DeviceManager] explicit DeviceID reset allowed', {
    reason,
    previous: current.slice(0, 8),
  });
  return legacy.rotateCurrentDeviceId(reason);
}
