import { Capacitor } from '@capacitor/core';
import { isVerifiedNativeRuntime } from '@/lib/runtimePlatform';

export function isNativeAndroidRuntime(): boolean {
  try {
    return isVerifiedNativeRuntime() && Capacitor.getPlatform?.() === 'android';
  } catch {
    return false;
  }
}

export function isAndroidRuntime(): boolean {
  if (isNativeAndroidRuntime()) return true;
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}
