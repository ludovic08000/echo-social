import { describe, expect, it } from 'vitest';
import {
  MAX_AUTO_DOWNLOAD_ATTACHMENT_BYTES,
  MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES,
  MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
  MAX_OUTGOING_ATTACHMENT_PLAINTEXT_BYTES,
  MEDIA_AES_GCM_OVERHEAD_BYTES,
  MEBIBYTE,
  getEncryptedMediaSize,
  isIncomingAttachmentTooLarge,
  isOutgoingAttachmentTooLarge,
} from '@/lib/messaging/attachmentLimits';

describe('Signal-style attachment limits', () => {
  it('uses Signal Desktop fallback limits', () => {
    expect(MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES).toBe(100 * MEBIBYTE);
    expect(MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES).toBe(125 * MEBIBYTE);
    expect(MAX_AUTO_DOWNLOAD_ATTACHMENT_BYTES).toBe(200 * MEBIBYTE);
  });

  it('accounts for the AES-GCM IV and authentication tag', () => {
    expect(MEDIA_AES_GCM_OVERHEAD_BYTES).toBe(28);
    expect(getEncryptedMediaSize(MAX_OUTGOING_ATTACHMENT_PLAINTEXT_BYTES))
      .toBe(MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES);
  });

  it('accepts the exact outgoing boundary and rejects one extra byte', () => {
    expect(isOutgoingAttachmentTooLarge(MAX_OUTGOING_ATTACHMENT_PLAINTEXT_BYTES)).toBe(false);
    expect(isOutgoingAttachmentTooLarge(MAX_OUTGOING_ATTACHMENT_PLAINTEXT_BYTES + 1)).toBe(true);
  });

  it('accepts the exact incoming boundary and rejects one extra byte', () => {
    expect(isIncomingAttachmentTooLarge(MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES)).toBe(false);
    expect(isIncomingAttachmentTooLarge(MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES + 1)).toBe(true);
  });
});
