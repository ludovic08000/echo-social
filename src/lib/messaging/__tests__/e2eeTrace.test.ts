import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearE2EETrace,
  readE2EETrace,
  sanitizeE2EETraceEvent,
  traceE2EE,
} from '@/lib/messaging/e2eeTrace';

describe('Aegis structured trace', () => {
  beforeEach(() => {
    clearE2EETrace();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('correlates blocks with local references without exposing raw identifiers', () => {
    const messageId = '99cf0ce0-8b37-46d9-8e91-f65a141f8bb6';
    traceE2EE({ direction: 'send', component: 'outbound_engine', stage: 'PARENT_ENCRYPT', outcome: 'start', messageId });
    traceE2EE({ direction: 'send', component: 'outbound_engine', stage: 'PARENT_ENCRYPT', outcome: 'ok', messageId, blockMs: 12 });

    const events = readE2EETrace();
    expect(events).toHaveLength(2);
    expect(events[0].messageRef).toBe('msg-001');
    expect(events[1].messageRef).toBe('msg-001');
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(JSON.stringify(events)).not.toContain(messageId);
  });

  it('never retains secrets or free-form server errors', () => {
    const sanitized = sanitizeE2EETraceEvent({
      direction: 'receive',
      stage: 'DEVICE_COPY_DECRYPT',
      messageId: 'raw-message-id',
      errorCode: 'failed with secret plaintext and token',
    });

    expect(sanitized).not.toHaveProperty('messageId');
    expect(sanitized.errorCode).toBe('FAILED');
    expect(JSON.stringify(sanitized)).not.toContain('secret plaintext');
  });
});
