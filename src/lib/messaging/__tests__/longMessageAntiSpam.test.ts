import { describe, expect, it } from 'vitest';
import { sanitizeMessageBody, validateMessage } from '@/lib/messageAntiSpam';
import { MAX_LONG_MESSAGE_BODY_BYTES, utf8ByteLength } from '../longMessageAttachment';

describe('long message validation', () => {
  it('does not truncate an accepted long body during sanitization', () => {
    const body = Array.from({ length: 1_500 }, (_, index) => `ligne-${index}`).join(' ');
    expect(utf8ByteLength(body)).toBeGreaterThan(2_048);
    expect(validateMessage(body).valid).toBe(true);
    expect(sanitizeMessageBody(`  ${body}  `)).toBe(body);
  });

  it('rejects over 64 KiB in UTF-8 even when JS character count is lower', () => {
    const body = '🙂'.repeat(Math.floor(MAX_LONG_MESSAGE_BODY_BYTES / 4) + 1);
    expect(body.length).toBeLessThan(MAX_LONG_MESSAGE_BODY_BYTES);
    expect(utf8ByteLength(body)).toBeGreaterThan(MAX_LONG_MESSAGE_BODY_BYTES);
    expect(validateMessage(body)).toEqual({
      valid: false,
      error: 'Le message est trop long (maximum 64 Kio en UTF-8).',
    });
  });
});
