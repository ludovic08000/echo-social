import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearDeviceFinalizationTrace, getDeviceFinalizationTrace, traceDeviceKeyChecks, traceDeviceFinalization } from '../deviceFinalizationTrace';
import { getAegisDiagnosticReport } from '@/lib/messaging/aegisDiagnosticReport';
import { isE2EEDebugEnabled, setE2EEDebugEnabled } from '@/lib/consoleGuard';
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
