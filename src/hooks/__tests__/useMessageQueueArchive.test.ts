import { describe, expect, it } from 'vitest';
import { buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { buildMultiDeviceParentEnvelope, selectInitialDeliveryMode, shouldArchiveMessageBody } from '../useMessageQueue';
import { classifyOutboundFailure } from '../useMessageQueueSignal';

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
  it('uses direct E2EE immediately for a fresh encrypted send', () => {
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: null,
      preparedCopyCount: 0,
    })).toBe('direct');
  });

  it('resumes Sesame only when exact prepared copies are already durable', () => {
    const parent = buildMultiDeviceParentEnvelope('local-resume', 'trace-resume');
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: parent,
      preparedCopyCount: 2,
    })).toBe('multi_device');
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: parent,
      preparedCopyCount: 0,
    })).toBe('direct');
  });

  it('keeps Zeus plaintext mode explicit', () => {
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: false,
      resumedEncryptedBody: null,
      preparedCopyCount: 0,
    })).toBe('plaintext');
  });

  it('retries transient encryption and lock failures instead of leaving sending stuck', () => {
    expect(classifyOutboundFailure(new Error('E2EE encryption lock timeout — automatic retry scheduled'))).toMatchObject({
      status: 'retry_pending',
    });
    expect(classifyOutboundFailure(new Error('Session Double Ratchet non prête'))).toMatchObject({
      status: 'retry_pending',
    });
  });

  it('keeps permanent identity and authentication failures visible', () => {
    expect(classifyOutboundFailure(new Error('Cle de securite du contact modifiee - verification obligatoire avant envoi'))).toMatchObject({
      status: 'failed_visible',
    });
    expect(classifyOutboundFailure(new Error('401 JWT unauthorized'))).toMatchObject({
      status: 'failed_visible',
      message: 'Session expirée — reconnectez-vous pour envoyer.',
    });
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
});
