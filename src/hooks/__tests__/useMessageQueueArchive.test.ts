import { describe, expect, it } from 'vitest';
import { buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { buildMultiDeviceParentEnvelope, shouldArchiveMessageBody, shouldUseInstantMultiDeviceParent } from '../useMessageQueue';

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
  it('builds a valid encrypted-only multi-device parent envelope', () => {
    const envelope = buildMultiDeviceParentEnvelope('local-1', 'trace-1');
    const parsed = JSON.parse(envelope);

    expect(isMultiDeviceEnvelopeBody(envelope)).toBe(true);
    expect(parsed).toMatchObject({
      encryptionMode: 'multi_device',
      v: PROTOCOL_VERSION,
      ct: 'device_copies',
      __lid: 'local-1',
      __tid: 'trace-1',
    });
    expect(envelope).not.toContain('hello');
  });

  it('uses the instant multi-device parent only when E2EE is ready but ratchet is not primed', () => {
    expect(shouldUseInstantMultiDeviceParent({
      isEncryptionActive: true,
      allowPlaintext: false,
      isEncryptionReady: true,
      isRatchetActive: false,
    })).toBe(true);

    expect(shouldUseInstantMultiDeviceParent({
      isEncryptionActive: true,
      allowPlaintext: false,
      isEncryptionReady: false,
      isRatchetActive: false,
    })).toBe(false);

    expect(shouldUseInstantMultiDeviceParent({
      isEncryptionActive: true,
      allowPlaintext: false,
      isEncryptionReady: true,
      isRatchetActive: true,
    })).toBe(false);

    expect(shouldUseInstantMultiDeviceParent({
      isEncryptionActive: true,
      allowPlaintext: true,
      isEncryptionReady: true,
      isRatchetActive: false,
    })).toBe(false);
  });
});
