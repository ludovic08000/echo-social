import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __test__,
  cancelSignalRetry,
  isRetryableOutboundStatus,
  retryDelayMs,
  runSignalConversationJob,
  scheduleSignalRetry,
} from '../signalWebConversationQueue';

afterEach(() => {
  __test__.reset();
  vi.useRealTimers();
});

describe('Signal-style web conversation queue', () => {
  it('serializes jobs belonging to the same conversation', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runSignalConversationJob('user:conversation', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = runSignalConversationJob('user:conversation', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('uses increasing bounded retry delays', () => {
    expect(retryDelayMs(0)).toBe(500);
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(3)).toBe(5_000);
    expect(retryDelayMs(99)).toBe(10_000);
  });

  it('runs a scheduled retry once and clears it after success', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);

    expect(scheduleSignalRetry('job-1', task)).toBe(true);
    expect(scheduleSignalRetry('job-1', task)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('preserves backoff while a retry is temporarily encrypting', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => {
      throw new Error('route unavailable');
    });

    scheduleSignalRetry('job-backoff', task);
    await vi.advanceTimersByTimeAsync(500);
    expect(__test__.attempts('job-backoff')).toBe(1);

    cancelSignalRetry('job-backoff', { resetAttempts: false });
    scheduleSignalRetry('job-backoff', task);
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('never starts two retries for the same outbox row concurrently', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = vi.fn(() => running);

    scheduleSignalRetry('job-single-flight', task);
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);

    scheduleSignalRetry('job-single-flight', task, { immediate: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await Promise.resolve();
  });

  it('does not auto-retry authentication or safety-number failures', () => {
    expect(isRetryableOutboundStatus('failed_visible', 'Session expirée — reconnectez-vous')).toBe(false);
    expect(isRetryableOutboundStatus('failed_visible', 'Clé de sécurité du contact modifiée')).toBe(false);
    expect(isRetryableOutboundStatus('failed_visible', 'Failed to fetch')).toBe(true);
    expect(isRetryableOutboundStatus('retry_pending', null)).toBe(true);
  });
});
