import { describe, expect, it } from 'vitest';
import { buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { shouldArchiveMessageBody } from '../useMessageQueue';

const MEDIA_KEY =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('useMessageQueue archive gating', () => {
  it('archives normal encrypted text bodies', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: 'hello',
        isSpecial: false,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(true);
  });

  it('archives encrypted media bodies that carry a media key', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: buildMediaMessageBody('Photo', MEDIA_KEY),
        isSpecial: true,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(true);
  });

  it('does not archive view-once media keys', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: buildMediaMessageBody('Photo', MEDIA_KEY),
        isSpecial: true,
        viewOnce: true,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(false);
  });

  it('does not archive legacy special labels without a media key', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: 'Photo',
        isSpecial: true,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(false);
  });

  it('does not archive when encryption was not used or required', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: buildMediaMessageBody('Photo', MEDIA_KEY),
        isSpecial: true,
        encryptedSuccessfully: false,
        encryptionWasRequired: false,
      }),
    ).toBe(false);
  });
});
