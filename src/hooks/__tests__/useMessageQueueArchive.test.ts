import { describe, expect, it } from 'vitest';
import { AEGIS_MESSAGE_PROTOCOL, createAegisMessage } from '@/lib/messaging/aegisEnvelope';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { selectInitialDeliveryMode } from '../useMessageQueue';
import { classifyOutboundFailure } from '../useMessageQueueSignal';

describe('useMessageQueue Aegis transport', () => {
  it('uses multi-device key fan-out for every fresh encrypted send', () => {
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: null,
      preparedCopyCount: 0,
    })).toBe('multi_device');
  });

  it('never downgrades to direct E2EE when prepared copies are absent', () => {
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: '{}',
      preparedCopyCount: 2,
    })).toBe('multi_device');
    expect(selectInitialDeliveryMode({
      encryptionWasRequired: true,
      resumedEncryptedBody: '{}',
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

  it('builds a valid encrypted-only Aegis parent envelope', async () => {
    const created = await createAegisMessage({
      messageId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
      senderId: '33333333-3333-4333-8333-333333333333',
      plaintext: 'hello',
      localId: 'local-1',
      traceId: 'trace-1',
    });
    const parsed = JSON.parse(created.body);

    expect(isMultiDeviceEnvelopeBody(created.body)).toBe(true);
    expect(parsed).toMatchObject({
      protocol: AEGIS_MESSAGE_PROTOCOL,
      version: 1,
      encryptionMode: 'multi_device',
      algorithm: 'AES-256-GCM',
      keyTransport: 'device_ratchet',
      localId: 'local-1',
      traceId: 'trace-1',
    });
    expect(created.body).not.toContain('hello');
  });

  it('waits for a route event when the canonical device channel is unavailable', () => {
    expect(classifyOutboundFailure(new Error('E2EE_DEVICE_COPIES_UNAVAILABLE'))).toMatchObject({
      status: 'waiting_secure_channel',
    });
    expect(classifyOutboundFailure(new Error('DEVICE_SPK_SIGNATURE_INVALID'))).toMatchObject({
      status: 'waiting_secure_channel',
    });
  });
});
