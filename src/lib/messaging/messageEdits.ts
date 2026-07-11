import { supabase } from '@/integrations/supabase/client';
import { safeUUID } from '@/e2ee-session';
import { validateMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { loadPlaintext, savePlaintext, savePlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { decryptArchive, encryptArchive } from '@/lib/messaging/archive/archiveKey';
import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import {
  encryptPlaintextForDeviceTarget,
  tryDecryptDeviceTargetedBody,
} from '@/lib/messaging/multiDeviceFanout';

export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;
const EDIT_CACHE_PREFIX = 'message-edit:';

export interface MessageEditRow {
  id: string;
  message_id: string;
  conversation_id: string;
  editor_user_id: string;
  revision: number;
  encrypted_body: string;
  archive_body: string | null;
  edited_at: string;
  created_at?: string;
}

export interface MessageEditMeta {
  id: string;
  conversation_id: string;
  sender_id: string;
  created_at: string;
  image_url: string | null;
  view_once?: boolean | null;
  document_url?: string | null;
}

export interface ResolvedMessageEdit {
  editId: string;
  messageId: string;
  conversationId: string;
  revision: number;
  text: string;
  editedAt: string;
}

export interface MessageEditDeviceCopy {
  edit_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  sender_device_id: string;
  encrypted_body: string;
}

export function editCacheKey(editId: string): string {
  return `${EDIT_CACHE_PREFIX}${editId}`;
}

export function buildMessageEditParentEnvelope(args: {
  editId: string;
  messageId: string;
  createdAt?: number;
}): string {
  return JSON.stringify({
    encryptionMode: 'message_edit',
    v: 1,
    ct: 'device_copies',
    editId: args.editId,
    messageId: args.messageId,
    ts: args.createdAt ?? Date.now(),
  });
}

export function selectLatestMessageEdit(rows: MessageEditRow[]): MessageEditRow | null {
  let latest: MessageEditRow | null = null;
  for (const row of rows) {
    if (!latest || row.revision > latest.revision) latest = row;
  }
  return latest;
}

export function isEditableTextContent(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return !(
    /^GIF:https?:\/\//i.test(value) ||
    /^🎙️\s*(?:vocal|voice):/i.test(value) ||
    /^🎬\s*(?:Video|Vidéo)/i.test(value) ||
    /^📷\s*Photo/i.test(value) ||
    /^📎\s*/i.test(value) ||
    value.includes('\x00MKEY:')
  );
}

export function canEditMessage(
  meta: MessageEditMeta | null | undefined,
  currentUserId: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!meta || !currentUserId || meta.sender_id !== currentUserId) return false;
  if (meta.image_url || meta.view_once || meta.document_url) return false;
  const createdAt = new Date(meta.created_at).getTime();
  if (!Number.isFinite(createdAt)) return false;
  return now >= createdAt && now - createdAt <= MESSAGE_EDIT_WINDOW_MS;
}

async function buildMessageEditCopies(args: {
  editId: string;
  conversationId: string;
  senderUserId: string;
  plaintext: string;
}): Promise<MessageEditDeviceCopy[]> {
  if (isDeviceIdTemporary()) {
    throw new Error('Appareil sécurisé non initialisé.');
  }

  const senderDeviceId = getCurrentDeviceId();
  const { data: participantRows, error: participantError } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', args.conversationId);
  if (participantError) throw participantError;

  const userIds = [...new Set((participantRows ?? []).map((row) => row.user_id))];
  if (userIds.length === 0) throw new Error('Conversation sans destinataire.');

  const targets = (await listFanoutTargets(args.senderUserId, userIds, { verifyPrekeys: false }))
    .filter((target) =>
      Boolean(target.devicePublicKey) &&
      !(target.userId === args.senderUserId && target.deviceId === senderDeviceId),
    );

  const encryptedRows = await Promise.all(
    targets.map(async (target): Promise<MessageEditDeviceCopy | null> => {
      try {
        const encrypted = await encryptPlaintextForDeviceTarget({
          conversationId: args.conversationId,
          senderUserId: args.senderUserId,
          senderDeviceId,
          recipientUserId: target.userId,
          recipientDeviceId: target.deviceId,
          recipientDevicePublicKey: target.devicePublicKey,
          plaintext: args.plaintext,
        });
        if (!encrypted) return null;
        return {
          edit_id: args.editId,
          recipient_user_id: target.userId,
          recipient_device_id: target.deviceId,
          sender_user_id: args.senderUserId,
          sender_device_id: encrypted.senderDeviceId,
          encrypted_body: encrypted.encryptedBody,
        };
      } catch {
        return null;
      }
    }),
  );

  const rows = encryptedRows.filter((row): row is MessageEditDeviceCopy => row !== null);
  const peerParticipants = userIds.filter((userId) => userId !== args.senderUserId);
  for (const peerUserId of peerParticipants) {
    const peerHadTrustedTarget = targets.some((target) => target.userId === peerUserId);
    const peerHasCopy = rows.some((row) => row.recipient_user_id === peerUserId);
    if (peerHadTrustedTarget && !peerHasCopy) {
      throw new Error('Impossible de chiffrer la modification pour un destinataire.');
    }
  }

  return rows;
}

export async function createEncryptedMessageEdit(args: {
  message: MessageEditMeta;
  currentUserId: string;
  plaintext: string;
}): Promise<ResolvedMessageEdit> {
  if (!canEditMessage(args.message, args.currentUserId)) {
    throw new Error('Ce message ne peut plus être modifié.');
  }

  const validation = validateMessage(args.plaintext);
  if (!validation.valid) throw new Error(validation.error);
  const sanitized = sanitizeMessageBody(args.plaintext).trim();
  if (!isEditableTextContent(sanitized)) {
    throw new Error('Seuls les messages texte peuvent être modifiés.');
  }

  const editId = safeUUID();
  const parentBody = buildMessageEditParentEnvelope({
    editId,
    messageId: args.message.id,
  });

  const [copies, archiveBody] = await Promise.all([
    buildMessageEditCopies({
      editId,
      conversationId: args.message.conversation_id,
      senderUserId: args.currentUserId,
      plaintext: sanitized,
    }),
    encryptArchive(sanitized, args.message.conversation_id, args.currentUserId).catch(() => null),
  ]);

  const { data, error } = await (supabase as any).rpc('send_message_edit_with_device_copies', {
    p_edit_id: editId,
    p_message_id: args.message.id,
    p_encrypted_body: parentBody,
    p_archive_body: archiveBody,
    p_copies: copies,
  });
  if (error) {
    const code = String(error.message || error.code || 'MESSAGE_EDIT_FAILED');
    if (code.includes('EDIT_WINDOW_EXPIRED')) throw new Error('Le délai de 15 minutes est dépassé.');
    if (code.includes('MEDIA_MESSAGES_CANNOT_BE_EDITED')) throw new Error('Ce type de message ne peut pas être modifié.');
    if (code.includes('ONLY_SENDER_CAN_EDIT')) throw new Error('Seul l’auteur peut modifier ce message.');
    throw new Error('Modification non envoyée. Réessayez.');
  }

  const result = data as {
    id?: string;
    revision?: number;
    edited_at?: string;
  } | null;
  const resolved: ResolvedMessageEdit = {
    editId: result?.id ?? editId,
    messageId: args.message.id,
    conversationId: args.message.conversation_id,
    revision: Number(result?.revision ?? 1),
    text: sanitized,
    editedAt: result?.edited_at ?? new Date().toISOString(),
  };

  await savePlaintext(editCacheKey(resolved.editId), sanitized);
  await savePlaintextForCiphertext(parentBody, sanitized);
  return resolved;
}

async function persistRecipientEditArchive(
  edit: MessageEditRow,
  currentUserId: string,
  plaintext: string,
): Promise<void> {
  try {
    const archiveBody = await encryptArchive(plaintext, edit.conversation_id, currentUserId);
    if (!archiveBody) return;
    await (supabase as any)
      .from('message_edit_archives')
      .upsert(
        { edit_id: edit.id, user_id: currentUserId, archive_body: archiveBody },
        { onConflict: 'edit_id,user_id' },
      );
  } catch {
    // Durable recipient history is best-effort; the device copy remains usable.
  }
}

export async function resolveMessageEditPlaintext(
  edit: MessageEditRow,
  currentUserId: string,
): Promise<string | null> {
  const cached = await loadPlaintext(editCacheKey(edit.id)).catch(() => null);
  if (cached) return cached;

  try {
    const { data: recipientArchive } = await (supabase as any)
      .from('message_edit_archives')
      .select('archive_body')
      .eq('edit_id', edit.id)
      .eq('user_id', currentUserId)
      .maybeSingle();
    const archivePayload = recipientArchive?.archive_body as string | undefined;
    if (archivePayload) {
      const plaintext = await decryptArchive(archivePayload, edit.conversation_id, currentUserId);
      if (plaintext !== null) {
        await savePlaintext(editCacheKey(edit.id), plaintext);
        return plaintext;
      }
    }
  } catch {
    // Fall through to sender archive or device copy.
  }

  if (edit.editor_user_id === currentUserId && edit.archive_body) {
    const plaintext = await decryptArchive(edit.archive_body, edit.conversation_id, currentUserId).catch(() => null);
    if (plaintext !== null) {
      await savePlaintext(editCacheKey(edit.id), plaintext);
      return plaintext;
    }
  }

  if (isDeviceIdTemporary()) return null;
  const currentDeviceId = getCurrentDeviceId();
  try {
    const { data: copy } = await (supabase as any)
      .from('message_edit_device_copies')
      .select('encrypted_body, sender_user_id, sender_device_id, recipient_device_id')
      .eq('edit_id', edit.id)
      .eq('recipient_user_id', currentUserId)
      .eq('recipient_device_id', currentDeviceId)
      .maybeSingle();

    if (!copy?.encrypted_body) return null;
    const plaintext = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: copy.encrypted_body,
        sender_user_id: copy.sender_user_id,
        sender_device_id: copy.sender_device_id,
      },
      currentUserId,
      currentDeviceId,
    );
    if (plaintext === null) return null;

    await savePlaintext(editCacheKey(edit.id), plaintext);
    await savePlaintextForCiphertext(edit.encrypted_body, plaintext);
    void persistRecipientEditArchive(edit, currentUserId, plaintext);
    return plaintext;
  } catch {
    return null;
  }
}
