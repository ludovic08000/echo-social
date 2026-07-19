import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { buildMultiDeviceParentEnvelope, selectInitialDeliveryMode } from '../useMessageQueue';
import { classifyOutboundFailure } from '../useMessageQueueSignal';

describe('useMessageQueue Sesame-lite transport', () => {
  it('uses Sesame-lite fan-out for every fresh encrypted send', () => {
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: null,
      preparedCopyCount: 0,
    })).toBe('multi_device');
  });

  it('never downgrades to direct E2EE when prepared copies are absent', () => {
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
    })).toBe('multi_device');
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
      protocol: 'forsure-sesame-lite',
      version: 1,
      encryptionMode: 'multi_device',
      v: PROTOCOL_VERSION,
      ct: 'device_copies',
      __lid: 'local-1',
      __tid: 'trace-1',
    });
    expect(envelope).not.toContain('hello');
  });
});
