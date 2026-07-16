import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scheduleBubbleRecovery,
  wakeBubbleRecovery,
  __test__,
} from '../bubbleRecoveryScheduler';

describe('bubbleRecoveryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
    __test__.reset();
  });

  afterEach(() => {
    __test__.reset();
    vi.useRealTimers();
  });

  it('coalesces many bubble tasks behind the centralized queue', () => {
    const callbacks = Array.from({ length: 100 }, () => vi.fn());
    callbacks.forEach((callback, index) => {
      scheduleBubbleRecovery(`message-${index}`, 500, callback);
    });

    expect(__test__.size()).toBe(100);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(500);
    callbacks.forEach((callback) => expect(callback).toHaveBeenCalledTimes(1));
    expect(__test__.size()).toBe(0);
  });

  it('replaces an older task for the same message', () => {
    const oldCallback = vi.fn();
    const newCallback = vi.fn();
    scheduleBubbleRecovery('same-message', 500, oldCallback);
    scheduleBubbleRecovery('same-message', 1_000, newCallback);

    vi.advanceTimersByTime(500);
    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(newCallback).toHaveBeenCalledTimes(1);
  });

  it('can wake one targeted encrypted bubble immediately', () => {
    const first = vi.fn();
    const second = vi.fn();
    scheduleBubbleRecovery('first', 8_000, first);
    scheduleBubbleRecovery('second', 8_000, second);

    wakeBubbleRecovery('first');
    vi.advanceTimersByTime(0);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
