import { describe, expect, it } from 'vitest';
import {
  AEGIS_VIEW_ONCE_PROTOCOL,
  parseViewOnceBeginState,
  parseViewOnceClaimReceipt,
  parseViewOnceCommitReceipt,
  shouldInstallViewOnceContent,
} from '@/lib/messaging/aegisViewOnceProtocol';

const messageId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const senderUserId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';

function claim(overrides: Record<string, unknown> = {}) {
  return {
    state: 'claimed',
    protocol: AEGIS_VIEW_ONCE_PROTOCOL,
    message_id: messageId,
    conversation_id: conversationId,
    sender_user_id: senderUserId,
    sender_device_id: 'sender-device-123',
    claim_token: claimToken,
    claim_expires_at: '2026-07-30T15:00:00.000Z',
    parent_body: 'aegis-message-envelope-long-enough',
    image_url: 'https://media.example/encrypted.bin',
    encrypted_body: 'aegis1.ratchet.payload',
    ...overrides,
  };
}

describe('Aegis view-once receipts', () => {
  it('accepts only the finite begin state set', () => {
    expect(parseViewOnceBeginState({ state: 'consumed' })).toBe('consumed');
    expect(parseViewOnceBeginState({ state: 'claimed_elsewhere' })).toBe('claimed_elsewhere');
    expect(parseViewOnceBeginState({ state: 'unexpected' })).toBeNull();
  });

  it('binds a claim to exact message, user, device, token and encrypted payload', () => {
    expect(parseViewOnceClaimReceipt(claim())).toMatchObject({
      messageId,
      conversationId,
      senderUserId,
      claimToken,
    });
    expect(parseViewOnceClaimReceipt(claim({ image_url: 'http://insecure.example/file' }))).toBeNull();
    expect(parseViewOnceClaimReceipt(claim({ encrypted_body: 'legacy.payload' }))).toBeNull();
    expect(parseViewOnceClaimReceipt(claim({ message_id: conversationId }))).not.toBeNull();
  });

  it('rejects malformed authoritative commit receipts', () => {
    expect(parseViewOnceCommitReceipt({
      state: 'committed',
      protocol: AEGIS_VIEW_ONCE_PROTOCOL,
      message_id: messageId,
      claim_token: claimToken,
      existing: false,
    })).toMatchObject({ messageId, claimToken, existing: false });
    expect(parseViewOnceCommitReceipt({
      state: 'committed',
      protocol: AEGIS_VIEW_ONCE_PROTOCOL,
      message_id: messageId,
      claim_token: claimToken,
      existing: 'false',
    })).toBeNull();
  });

  it('installs content only when both server and parent bind the expected UUID', () => {
    expect(shouldInstallViewOnceContent({
      beginMessageId: messageId,
      expectedMessageId: messageId,
      parentEnvelopeMessageId: messageId,
      hasImageUrl: true,
      hasMediaKey: true,
    })).toBe(true);
    expect(shouldInstallViewOnceContent({
      beginMessageId: messageId,
      expectedMessageId: messageId,
      parentEnvelopeMessageId: conversationId,
      hasImageUrl: true,
      hasMediaKey: true,
    })).toBe(false);
  });
});
