import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_FINALIZATION_TRACE_MAX_EVENTS,
  clearDeviceFinalizationTrace,
  getCurrentDeviceFinalizationTraceId,
  getDeviceFinalizationTrace,
  maskIdentifier,
  normalizeFinalizationErrorCode,
  setCurrentDeviceFinalizationTraceId,
  traceCurrentDeviceFinalization,
  traceDeviceFinalization,
} from '@/lib/device-manager/deviceFinalizationTrace';

const USER_ID = '2b0a2ec7-6de0-4d02-9a6f-05f9b1f7f0aa';
const DEVICE_ID = 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d';

describe('device finalization trace', () => {
  beforeEach(() => {
    clearDeviceFinalizationTrace();
    setCurrentDeviceFinalizationTraceId(null);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('never exposes raw identifiers, secrets or raw server errors', () => {
    traceDeviceFinalization({
      traceId: 'dft_test',
      step: 'step.syncing_account',
      outcome: 'failure',
      userId: USER_ID,
      deviceId: DEVICE_ID,
      errorCode: new Error('DEVICE_ROUTE_NOT_READY: token=abcdef secret pin 123456'),
      state: {
        approvalStatus: 'approved',
        bindingStatus: 'bound',
        routingStatus: 'ready',
        lifecycleStatus: 'binding',
        isActive: true,
        revoked: false,
      },
    });

    const [event] = getDeviceFinalizationTrace();
    const dumped = JSON.stringify(event);
    expect(dumped).not.toContain(USER_ID);
    expect(dumped).not.toContain(DEVICE_ID);
    expect(dumped).not.toContain('token=abcdef');
    expect(dumped).not.toContain('123456');
    expect(event.errorCode).toBe('DEVICE_ROUTE_NOT_READY');
    expect(event.userRef).toBe(maskIdentifier(USER_ID));
    expect(event.state?.lifecycleStatus).toBe('binding');
  });

  it('normalizes unknown errors and timeouts to allowlisted codes', () => {
    expect(normalizeFinalizationErrorCode(new Error('boom raw server text'))).toBe('UNKNOWN_ERROR');
    expect(normalizeFinalizationErrorCode('DEVICE_BINDING_TIMEOUT')).toBe('DEVICE_BINDING_TIMEOUT');
    expect(normalizeFinalizationErrorCode('failed to fetch')).toBe('NETWORK_ERROR');
  });

  it('keeps event order and correlates sync then finalize with the same traceId', () => {
    setCurrentDeviceFinalizationTraceId('dft_pipeline');
    traceCurrentDeviceFinalization({ step: 'account_key_sync', outcome: 'start' });
    traceCurrentDeviceFinalization({ step: 'account_key_sync', outcome: 'success', elapsedMs: 12 });
    traceCurrentDeviceFinalization({ step: 'rpc.complete_current_device_synchronization', outcome: 'success' });

    const events = getDeviceFinalizationTrace();
    expect(events.map((event) => `${event.step}:${event.outcome}`)).toEqual([
      'account_key_sync:start',
      'account_key_sync:success',
      'rpc.complete_current_device_synchronization:success',
    ]);
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set(['dft_pipeline']));
    expect(events.map((event) => event.seq)).toEqual([...events].sort((a, b) => a.seq - b.seq).map((e) => e.seq));
    expect(getCurrentDeviceFinalizationTraceId()).toBe('dft_pipeline');
  });

  it('bounds the memory buffer', () => {
    for (let i = 0; i < DEVICE_FINALIZATION_TRACE_MAX_EVENTS + 50; i += 1) {
      traceDeviceFinalization({ traceId: 'dft_bound', step: `step.${i}`, outcome: 'info' });
    }
    const events = getDeviceFinalizationTrace();
    expect(events).toHaveLength(DEVICE_FINALIZATION_TRACE_MAX_EVENTS);
    expect(events[events.length - 1].step).toBe(`step.${DEVICE_FINALIZATION_TRACE_MAX_EVENTS + 49}`);
    expect(getDeviceFinalizationTrace(10)).toHaveLength(10);
  });
});
