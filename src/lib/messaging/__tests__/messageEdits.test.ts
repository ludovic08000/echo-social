import { describe, expect, it } from 'vitest';
import {
  MESSAGE_EDIT_WINDOW_MS,
  buildMessageEditParentEnvelope,
  canEditMessage,
  isEditableTextContent,
  selectLatestMessageEdit,
  type MessageEditMeta,
  type MessageEditRow,
} from '@/lib/messaging/messageEdits';

const USER = '11111111-1111-4111-8111-111111111111';

function meta(overrides: Partial<MessageEditMeta> = {}): MessageEditMeta {
  return {
    id: 'message-1',
    conversation_id: 'conversation-1',
    sender_id: USER,
    created_at: new Date(1_000_000).toISOString(),
    image_url: null,
    view_once: false,
    document_url: null,
    ...overrides,
  };
}

function edit(revision: number): MessageEditRow {
  return {
    id: `edit-${revision}`,
    message_id: 'message-1',
    conversation_id: 'conversation-1',
    editor_user_id: USER,
    revision,
    encrypted_body: `parent-${revision}`,
    archive_body: null,
    edited_at: new Date(1_000_000 + revision).toISOString(),
  };
}

describe('message edit invariants', () => {
  it('allows only the sender during the 15-minute server window', () => {
    expect(canEditMessage(meta(), USER, 1_000_000 + MESSAGE_EDIT_WINDOW_MS)).toBe(true);
    expect(canEditMessage(meta(), USER, 1_000_001 + MESSAGE_EDIT_WINDOW_MS)).toBe(false);
    expect(canEditMessage(meta(), '22222222-2222-4222-8222-222222222222', 1_000_100)).toBe(false);
  });

  it('rejects media, view-once and document messages', () => {
    expect(canEditMessage(meta({ image_url: 'https://example.test/media' }), USER, 1_000_100)).toBe(false);
    expect(canEditMessage(meta({ view_once: true }), USER, 1_000_100)).toBe(false);
    expect(canEditMessage(meta({ document_url: 'https://example.test/document' }), USER, 1_000_100)).toBe(false);
  });

  it('selects the highest revision regardless of arrival order', () => {
    expect(selectLatestMessageEdit([edit(2), edit(1), edit(3)])?.revision).toBe(3);
  });

  it('keeps plaintext out of the immutable parent envelope', () => {
    const plaintext = 'contenu ultra secret';
    const envelope = buildMessageEditParentEnvelope({
      editId: 'edit-1',
      messageId: 'message-1',
      createdAt: 123,
    });
    expect(envelope).not.toContain(plaintext);
    expect(JSON.parse(envelope)).toMatchObject({
      encryptionMode: 'message_edit',
      ct: 'device_copies',
      editId: 'edit-1',
      messageId: 'message-1',
    });
  });

  it('only treats ordinary text as editable', () => {
    expect(isEditableTextContent('Bonjour')).toBe(true);
    expect(isEditableTextContent('GIF:https://example.test/a.gif')).toBe(false);
    expect(isEditableTextContent('🎙️ voice:https://example.test/a|3')).toBe(false);
    expect(isEditableTextContent('📷 Photo')).toBe(false);
    expect(isEditableTextContent('secret\x00MKEY:key')).toBe(false);
  });
});
