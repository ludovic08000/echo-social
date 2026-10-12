import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeVisibleMessageReads } from '../visibleMessageReads';

let dispose: (() => void) | undefined;
let root: HTMLElement;
const rect = (top: number, bottom: number, left = 0, right = 200) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top }) as DOMRect;

function message(id: string, top: number, bottom: number) {
  const element = document.createElement('div');
  element.dataset.aegisMessageId = id;
  element.getBoundingClientRect = vi.fn(() => rect(top, bottom));
  root.append(element);
  return element;
}

describe('visible message read receipts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    root = document.createElement('div');
    root.getBoundingClientRect = () => rect(100, 500);
    document.body.append(root);
  });
  afterEach(() => {
    dispose?.();
    root.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('only acknowledges visible, eligible, decrypted messages and deduplicates scrolls', async () => {
    message('visible', 200, 250);
    message('offscreen', 550, 600);
    message('encrypted', 270, 320);
    message('own-or-view-once', 350, 400);
    const ack = vi.fn(async () => {});
    dispose = observeVisibleMessageReads({ container: root,
      messageIds: new Set(['visible', 'offscreen', 'encrypted']),
      canRead: (id) => id !== 'encrypted', acknowledge: ack });
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).toHaveBeenCalledExactlyOnceWith(['visible']);
    root.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(600);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a message only after it scrolls into view', async () => {
    const element = message('later', 550, 600);
    const ack = vi.fn(async () => {});
    dispose = observeVisibleMessageReads({ container: root, messageIds: new Set(['later']), canRead: () => true, acknowledge: ack });
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).not.toHaveBeenCalled();
    element.getBoundingClientRect = () => rect(200, 250);
    root.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).toHaveBeenCalledExactlyOnceWith(['later']);
  });

  it('does not send when the page becomes hidden before the batch flushes', async () => {
    message('hidden', 200, 250);
    const ack = vi.fn(async () => {});
    dispose = observeVisibleMessageReads({ container: root, messageIds: new Set(['hidden']), canRead: () => true, acknowledge: ack });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).toHaveBeenCalledExactlyOnceWith(['hidden']);
  });

  it('honors ghost mode at dispatch time and cancels scheduled reads on teardown', async () => {
    message('ghost', 200, 250);
    let allowed = true;
    const ack = vi.fn(async () => {});
    dispose = observeVisibleMessageReads({ container: root, messageIds: new Set(['ghost']), canRead: () => allowed, acknowledge: ack });
    allowed = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).not.toHaveBeenCalled();
    allowed = true;
    root.dispatchEvent(new Event('scroll'));
    dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).not.toHaveBeenCalled();
  });

  it('retries failed receipts without falsely remembering success', async () => {
    message('retry', 200, 250);
    const ack = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    dispose = observeVisibleMessageReads({ container: root, messageIds: new Set(['retry']), canRead: () => true, acknowledge: ack });
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ack).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it('rejects a widget positioned outside the browser viewport', async () => {
    root.getBoundingClientRect = () => rect(-500, -100);
    message('outside', -400, -350);
    const ack = vi.fn(async () => {});
    dispose = observeVisibleMessageReads({ container: root, messageIds: new Set(['outside']), canRead: () => true, acknowledge: ack });
    await vi.advanceTimersByTimeAsync(300);
    expect(ack).not.toHaveBeenCalled();
  });
});
