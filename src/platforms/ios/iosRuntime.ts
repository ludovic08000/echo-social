/**
 * Pure browser iOS detection for the web/PWA device flow.
 *
 * Security invariant: this module has zero Capacitor/native dependency. iOS
 * device recovery is WebAuthn/Passkey only and must work in Safari/Chrome/PWA
 * without Xcode or an installed native shell.
 */
export interface IosWebRuntimeInfo {
  isIosWeb: boolean;
  isIPadOS: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

const IOS_UA_RE = /(iPhone|iPad|iPod)/i;

export function inspectIosWebRuntime(): IosWebRuntimeInfo {
  if (typeof navigator === 'undefined') {
    return {
      isIosWeb: false,
      isIPadOS: false,
      userAgent: '',
      platform: '',
      maxTouchPoints: 0,
    };
  }

  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
  const isIPadOS = platform === 'MacIntel' && maxTouchPoints > 1;

  return {
    isIosWeb: IOS_UA_RE.test(userAgent) || isIPadOS,
    isIPadOS,
    userAgent,
    platform,
    maxTouchPoints,
  };
}

export function isIosWebRuntime(): boolean {
  return inspectIosWebRuntime().isIosWeb;
}
