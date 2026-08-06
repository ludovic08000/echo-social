import { describe, expect, it } from 'vitest';
import { classifyRuntimePlatform } from '@/lib/runtimePlatform';

describe('runtimePlatform', () => {
  it('forces Chrome on iPhone to web even when a stale Capacitor bridge claims native iOS', () => {
    expect(classifyRuntimePlatform({
      capacitorPlatform: 'ios',
      capacitorNative: true,
      protocol: 'https:',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.7922.57 Mobile/15E148 Safari/604.1',
    })).toBe('web');
  });

  it('forces Safari/PWA on iPhone to web', () => {
    expect(classifyRuntimePlatform({
      capacitorPlatform: 'web',
      capacitorNative: false,
      protocol: 'https:',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
    })).toBe('web');
  });

  it('keeps the real Capacitor iOS shell native', () => {
    expect(classifyRuntimePlatform({
      capacitorPlatform: 'ios',
      capacitorNative: true,
      protocol: 'capacitor:',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    })).toBe('native');
  });

  it('keeps a real Capacitor Android shell native', () => {
    expect(classifyRuntimePlatform({
      capacitorPlatform: 'android',
      capacitorNative: true,
      protocol: 'http:',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile',
    })).toBe('native');
  });
});
