import { Capacitor } from '@capacitor/core';

/**
 * Request camera & microphone permissions.
 * On web: uses navigator.mediaDevices (prompt handled by browser).
 * On native (Capacitor): also uses web API since LiveKit runs in WebView.
 * Returns true if permissions granted.
 */
export async function requestMediaPermissions(
  options: { audio?: boolean; video?: boolean } = { audio: true, video: true }
): Promise<{ granted: boolean; error?: string }> {
  try {
    const constraints: MediaStreamConstraints = {};
    if (options.audio) constraints.audio = {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (options.video) constraints.video = true;

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Stop tracks immediately — we just needed the permission
    stream.getTracks().forEach(t => t.stop());
    return { granted: true };
  } catch (err: any) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return {
        granted: false,
        error: Capacitor.isNativePlatform()
          ? 'Autorisez la caméra et le micro dans les réglages de votre appareil'
          : 'Autorisez l\'accès à la caméra et au micro dans votre navigateur',
      };
    }
    if (err.name === 'NotFoundError') {
      return { granted: false, error: 'Aucun périphérique média détecté' };
    }
    return { granted: false, error: 'Impossible d\'accéder aux médias' };
  }
}

/**
 * Keeps screen awake during a call (uses Wake Lock API where available).
 */
let wakeLock: WakeLockSentinel | null = null;

export async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
    }
  } catch {
    // Silently fail — not critical
  }
}

export async function releaseWakeLock() {
  try {
    await wakeLock?.release();
    wakeLock = null;
  } catch {
    // Silently fail
  }
}

/**
 * Detect platform for UI adjustments.
 */
export function getPlatform(): 'ios' | 'android' | 'web' {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() as 'ios' | 'android';
  }
  return 'web';
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}
