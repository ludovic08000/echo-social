/**
 * Abstraction du pont Capacitor iOS.
 *
 * Invariant : aucun appel de plugin natif ne doit être tenté depuis un
 * navigateur iOS (Safari/Chrome/PWA). `isVerifiedNativeRuntime` reste la seule
 * source de vérité, partagée avec le routeur secureStore existant.
 */
import { Capacitor } from '@capacitor/core';
import { isVerifiedNativeRuntime } from '@/lib/runtimePlatform';

export interface IosBridgeInfo {
  /** Shell Capacitor iOS réel (pas un bridge résiduel de navigateur). */
  isNativeIos: boolean;
  /** Plateforme rapportée par Capacitor, à titre de contexte seulement. */
  reportedPlatform: string;
  /** Runtime web iOS (Safari, Chrome iOS, PWA). */
  isIosWeb: boolean;
  userAgent: string;
}

const IOS_DEVICE_RE = /(iPhone|iPad|iPod)/i;

export function inspectIosBridge(): IosBridgeInfo {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let reportedPlatform = 'web';
  try {
    reportedPlatform = Capacitor.getPlatform?.() ?? 'web';
  } catch {
    reportedPlatform = 'web';
  }

  const native = isVerifiedNativeRuntime();
  const isNativeIos = native && reportedPlatform.toLowerCase() === 'ios';
  const isAppleDevice = IOS_DEVICE_RE.test(userAgent)
    || (typeof navigator !== 'undefined'
      && navigator.platform === 'MacIntel'
      && navigator.maxTouchPoints > 1);

  return {
    isNativeIos,
    reportedPlatform,
    isIosWeb: isAppleDevice && !isNativeIos,
    userAgent,
  };
}

export function isNativeIosRuntime(): boolean {
  return inspectIosBridge().isNativeIos;
}

export function isIosRuntime(): boolean {
  const info = inspectIosBridge();
  return info.isNativeIos || info.isIosWeb;
}
