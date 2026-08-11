import { isVerifiedNativeRuntime } from '@/lib/runtimePlatform';

const IOS_DEVICE_RE = /(iPhone|iPad|iPod)/i;

function isIpadDesktopMode(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * True only for iOS/iPadOS running the web/PWA application over HTTP(S).
 *
 * - Safari/Chrome/Firefox on iPhone/iPad => true
 * - installed iOS PWA => true
 * - Capacitor/native iOS => false
 * - Windows/macOS/Linux web => false
 */
export function isIosWebRuntime(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (isVerifiedNativeRuntime()) return false;

  const protocol = window.location?.protocol?.toLowerCase?.() ?? '';
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  return IOS_DEVICE_RE.test(navigator.userAgent || '') || isIpadDesktopMode();
}
