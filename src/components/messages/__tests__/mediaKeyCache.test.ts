import { describe, expect, it, vi } from 'vitest';
import {
  clearMediaKey,
  setMediaKey,
  subscribeMediaKey,
} from '@/components/messages/mediaKeyCache';

describe('mediaKeyCache', () => {
  it('does not notify mounted media bubbles for an identical key', () => {
    const messageId = 'msg-idempotent-media-key';
    const notify = vi.fn();
    clearMediaKey(messageId);
    const unsubscribe = subscribeMediaKey(messageId, notify);

    setMediaKey(messageId, 'same-key', false);
    setMediaKey(messageId, 'same-key', false);
    setMediaKey(messageId, 'same-key', true);

    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    clearMediaKey(messageId);
  });
});
