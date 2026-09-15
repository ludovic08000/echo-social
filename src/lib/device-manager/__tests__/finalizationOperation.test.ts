import { afterEach, expect, it, vi } from 'vitest';
import { clearDeviceFinalizationTrace, getDeviceFinalizationTrace, setCurrentDeviceFinalizationTraceId, traceFinalizationOperation } from '../deviceFinalizationTrace';

afterEach(() => { vi.useRealTimers(); clearDeviceFinalizationTrace(); setCurrentDeviceFinalizationTraceId(null); });

it('keeps correlation across retries, reports waiting and never exports the result', async () => {
  vi.useFakeTimers();
  setCurrentDeviceFinalizationTraceId('first');
  let resolve!: (value: string) => void;
  const promise = traceFinalizationOperation('test.operation', () => new Promise<string>(r => { resolve = r; }));
  setCurrentDeviceFinalizationTraceId('retry');
  await vi.advanceTimersByTimeAsync(15_000);
  resolve('private-material');
  await expect(promise).resolves.toBe('private-material');
  const events = getDeviceFinalizationTrace();
  expect(events.map(e => e.outcome)).toEqual(['start', 'info', 'success']);
  expect(events.every(e => e.traceId === 'first')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private-material');
  expect(vi.getTimerCount()).toBe(0);
});

it('rethrows the original error but only exports its allowed code', async () => {
  vi.useFakeTimers();
  const error = new Error('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED:private-material');
  await expect(traceFinalizationOperation('test.operation', async () => { throw error; })).rejects.toBe(error);
  expect(getDeviceFinalizationTrace().at(-1)?.errorCode).toBe('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED');
  expect(JSON.stringify(getDeviceFinalizationTrace())).not.toContain('private-material');
  expect(vi.getTimerCount()).toBe(0);
});
