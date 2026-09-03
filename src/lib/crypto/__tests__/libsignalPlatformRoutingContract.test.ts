import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('libsignal platform routing contract', () => {
  it('routes runtime and provisioning through the platform bridge', () => {
    const runtime = readFileSync('src/lib/crypto/libsignalRuntime.ts', 'utf8');
    const provisioning = readFileSync('src/lib/crypto/libsignalProvisioning.ts', 'utf8');

    expect(runtime).toContain("from './libsignalPlatformBridge'");
    expect(provisioning).toContain("from './libsignalPlatformBridge'");
    expect(runtime).not.toContain("from './aegisWasmBridge'");
    expect(provisioning).not.toContain("from './aegisWasmBridge'");
  });

  it('fails closed to native LibSignal on verified Android/iOS runtimes', () => {
    const router = readFileSync('src/lib/crypto/libsignalPlatformBridge.ts', 'utf8');

    expect(router).toContain("registerPlugin<NativeLibsignalPlugin>('LibSignal')");
    expect(router).toContain("platform === 'android' || platform === 'ios'");
    expect(router).toContain('await commitNativeStore');
    expect(router).not.toContain('catch(() => createWasm');
  });
});
