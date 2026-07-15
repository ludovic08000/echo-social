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
]);

/**
 * Device IDs are immutable routing identities. A revoked server row is an
 * approval/lifecycle problem, not permission to silently invent a new device.
 * Automatic rotation created orphan rows, invalid SPKs and empty bubbles.
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
