import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { clearDeviceFinalizationTrace, getDeviceFinalizationTrace, traceDeviceKeyChecks, traceDeviceFinalization } from '../deviceFinalizationTrace';
import { getAegisDiagnosticReport } from '@/lib/messaging/aegisDiagnosticReport';
import { installE2EEDebugHelper, isE2EEDebugEnabled, setE2EEDebugEnabled } from '@/lib/consoleGuard';
import { clearE2EETrace, traceE2EE } from '@/lib/messaging/e2eeTrace';

beforeEach(() => { clearDeviceFinalizationTrace(); clearE2EETrace(); sessionStorage.clear(); setE2EEDebugEnabled(false); });
afterEach(() => { vi.useRealTimers(); setE2EEDebugEnabled(false); });

it('distinguishes an absent exchange key from a mismatched signing key', () => {
  traceDeviceKeyChecks({ userId: 'USER_SECRET', deviceId: 'DEVICE_SECRET' }, {
    signingPresent: true, exchangePresent: false, signingMatches: false, exchangeMatches: null,
  });
  expect(getDeviceFinalizationTrace().map(e => e.outcome)).toEqual(['success', 'failure', 'failure', 'skipped']);
  expect(JSON.stringify(getDeviceFinalizationTrace())).not.toContain('SECRET');
});

it('preserves CRYPTO_NOT_READY and removes free-form server state, codes and details', () => {
  traceDeviceFinalization({ traceId: 'dft_test', step: 'crypto_readiness', outcome: 'failure',
    errorCode: 'CRYPTO_NOT_READY:key_setup_required SECRET', detail: 'SECRET_TOKEN',
    state: { lifecycleStatus: 'syncing', routingStatus: 'SECRET_KEY' } });
  const [event] = getDeviceFinalizationTrace();
  expect(event.errorCode).toBe('CRYPTO_NOT_READY');
  expect(event.state).toEqual({ lifecycleStatus: 'syncing', routingStatus: 'unknown' });
  expect(JSON.stringify(event)).not.toContain('SECRET');
});

it('exports more than the 20 visible events plus the correlated messaging trace', () => {
  for (let i = 0; i < 35; i++) traceDeviceFinalization({ traceId: 'dft_test', step: `step.${i}`, outcome: 'info' });
  const id = '8a4c1d2e-64ba-4219-8c6c-893f3a702f98';
  traceE2EE({ direction: 'send', stage: 'HTTP_RESPONSE', diagnosticId: id, errorCode: 'TOKEN_SECRET_SENTINEL' });
  const report = getAegisDiagnosticReport();
  expect(report.deviceFinalization).toHaveLength(35);
  expect(report.messaging[0].diagnosticId).toBe(id);
  expect(JSON.stringify(report)).not.toContain('SECRET');
});

it('is opt-in, can be stopped, and expires after ten minutes without reactivation', () => {
  vi.useFakeTimers();
  expect(isE2EEDebugEnabled()).toBe(false);
  setE2EEDebugEnabled(true);
  expect(isE2EEDebugEnabled()).toBe(true);
  vi.advanceTimersByTime(600_001);
  expect(isE2EEDebugEnabled()).toBe(false);
  setE2EEDebugEnabled(true); setE2EEDebugEnabled(false);
  expect(isE2EEDebugEnabled()).toBe(false);
});

it('installs the console helper without locking the console or activating debug', async () => {
  const diagnosticWindow = window as typeof window & {
    forsureDebug?: {
      enabled: () => boolean; enable: () => void; disable: () => void;
      report: () => Promise<ReturnType<typeof getAegisDiagnosticReport>>;
    };
  };
  const previous = diagnosticWindow.forsureDebug;
  const originalLog = console.log;
  const originalFetch = window.fetch;
  try {
    installE2EEDebugHelper();
    const helper = diagnosticWindow.forsureDebug!;
    expect(helper).toBeDefined();
    expect(helper.enabled()).toBe(false);
    expect(console.log).toBe(originalLog);
    expect(window.fetch).toBe(originalFetch);
    expect(Object.isFrozen(console)).toBe(false);
    traceDeviceKeyChecks({ userId: 'USER_SECRET', deviceId: 'DEVICE_SECRET' }, {
      signingPresent: true, exchangePresent: true, signingMatches: true, exchangeMatches: true,
    });
    const report = await helper.report();
    expect(report.deviceFinalization).toHaveLength(4);
    expect(JSON.stringify(report)).not.toContain('SECRET');
    helper.enable();
    expect(helper.enabled()).toBe(true);
    helper.disable();
    expect(helper.enabled()).toBe(false);
  } finally {
    diagnosticWindow.forsureDebug = previous;
  }
});

it('initializes the diagnostic helper in the real application entrypoint', () => {
  const entrypoint = readFileSync('src/main.tsx', 'utf8');
  expect(entrypoint).toMatch(/import\s*\{\s*installE2EEDebugHelper\s*\}\s*from\s*["']@\/lib\/consoleGuard["']/);
  expect(entrypoint).toContain('installE2EEDebugHelper();');
  expect(entrypoint).not.toContain('lockdownConsole(');
});
