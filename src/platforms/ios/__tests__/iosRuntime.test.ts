import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectIosWebRuntime, isIosWebRuntime } from '@/platforms/ios/iosRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNavigator(args: { userAgent: string; platform: string; maxTouchPoints: number }) {
  vi.stubGlobal('navigator', args);
}

describe('iosRuntime', () => {
  it('détecte un iPhone Safari/Chrome iOS par user agent', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    expect(isIosWebRuntime()).toBe(true);
  });

  it('détecte un iPad classique', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      platform: 'iPad',
      maxTouchPoints: 5,
    });
    expect(isIosWebRuntime()).toBe(true);
  });

  it('détecte iPadOS qui se présente comme MacIntel', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    const info = inspectIosWebRuntime();
    expect(info.isIosWeb).toBe(true);
    expect(info.isIPadOS).toBe(true);
  });

  it('ne classe pas Windows comme iOS', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
      platform: 'Win32',
      maxTouchPoints: 0,
    });
    expect(isIosWebRuntime()).toBe(false);
  });
});
