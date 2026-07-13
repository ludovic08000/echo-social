import { beforeEach, describe, expect, it, vi } from 'vitest';

const local = new Map<string, string>();
const session = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
    clear: () => local.clear(),
  },
});

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
    clear: () => session.clear(),
  },
});

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: globalThis,
});

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'vitest', clipboard: { writeText: vi.fn() } },
});

import {
  bubbleDiagnostic,
  clearBubbleDiagnostics,
  exportBubbleDiagnostics,
  getBubbleDiagnostics,
} from '@/lib/messaging/bubbleDiagnostics';

describe('bubble diagnostics privacy', () => {
  beforeEach(() => {
    clearBubbleDiagnostics();
    local.clear();
  });

  it('redacts plaintext, body, ciphertext and key material', () => {
    bubbleDiagnostic('DECRYPT_FAILED', {
      messageId: 'message-1',
      details: {
        plaintext: 'secret visible text',
        body: 'another secret body',
        ciphertext: 'cipher-secret',
        encryptedBody: 'encrypted-secret',
        archiveBody: 'archive-secret',
        mediaKeyB64: 'key-secret',
        status: 'retry_pending',
      },
    });

    const [entry] = getBubbleDiagnostics();
    expect(entry.details).toMatchObject({
      plaintextLength: 19,
      bodyLength: 19,
      ciphertextLength: 13,
      encryptedBodyLength: 16,
      archiveBodyLength: 14,
      mediaKeyB64Length: 10,
      status: 'retry_pending',
    });

    const exported = exportBubbleDiagnostics();
    expect(exported).not.toContain('secret visible text');
    expect(exported).not.toContain('another secret body');
    expect(exported).not.toContain('cipher-secret');
    expect(exported).not.toContain('key-secret');
  });

  it('keeps only the bounded recent event window', () => {
    for (let index = 0; index < 1_600; index += 1) {
      bubbleDiagnostic('UNKNOWN', { reason: `event-${index}` });
    }
    const events = getBubbleDiagnostics();
    expect(events).toHaveLength(1_500);
    expect(events[0].reason).toBe('event-100');
    expect(events.at(-1)?.reason).toBe('event-1599');
  });
});
