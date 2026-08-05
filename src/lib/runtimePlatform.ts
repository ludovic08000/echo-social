import { Capacitor } from '@capacitor/core';

export interface RuntimePlatformProbe {
  capacitorPlatform: string;
  capacitorNative: boolean;
  protocol: string;
  userAgent: string;
}

const IOS_BROWSER_RE = /(CriOS|FxiOS|EdgiOS|OPiOS|Version\/.*Safari)/i;
const IOS_DEVICE_RE = /(iPhone|iPad|iPod)/i;

export function classifyRuntimePlatform(
  probe: RuntimePlatformProbe,
): 'native' | 'web' {
  const platform = probe.capacitorPlatform.toLowerCase();
  const protocol = probe.protocol.toLowerCase();
  const isHttpDocument = protocol === 'http:' || protocol === 'https:';
  const isIOSBrowser = IOS_DEVICE_RE.test(probe.userAgent)
    && IOS_BROWSER_RE.test(probe.userAgent)
    && isHttpDocument;

  // All iOS browsers run in WebKit and must never call Capacitor plugins.
  // This also protects against a stale bridge injected by an old shell or SW.
  if (platform === 'web' || isIOSBrowser) return 'web';

  return probe.capacitorNative && (platform === 'ios' || platform === 'android')
    ? 'native'
    : 'web';
}

export function isVerifiedNativeRuntime(): boolean {
  try {
    return classifyRuntimePlatform({
      capacitorPlatform: Capacitor.getPlatform?.() ?? 'web',
      capacitorNative: Capacitor.isNativePlatform?.() === true,
      protocol: typeof window !== 'undefined' ? window.location.protocol : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    }) === 'native';
  } catch {
    return false;
  }
}
