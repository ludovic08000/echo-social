import type { EventType, MatrixEvent, RoomEvent } from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events';
import {
  decryptAttachment,
  encryptAttachment,
  type IEncryptedFile,
} from 'matrix-encrypt-attachment';
import { getMatrixClient } from './client';
import { ensureMatrixRoom } from './rooms';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ROOM_MESSAGE_EVENT = 'm.room.message' as EventType.RoomMessage;
const ROOM_TIMELINE_EVENT = 'Room.timeline' as RoomEvent.Timeline;

export type MatrixMessage = {
  body: string;
  createdAt: string;
  eventId: string;
  file?: {
    encryptedFile: IEncryptedFile & { url: string };
    mimeType: string;
    name: string;
    size: number;
  };
  senderId: string;
  status: 'delivered';
};

function contentToMessage(event: MatrixEvent): MatrixMessage | null {
  if (event.getType() !== ROOM_MESSAGE_EVENT || event.isDecryptionFailure()) return null;
  const content = event.getContent<Record<string, unknown>>();
  const eventId = event.getId();
  const senderId = event.getSender();
  if (!eventId || !senderId || typeof content.body !== 'string') return null;

  const file = content.file as (IEncryptedFile & { url?: string }) | undefined;
  const info = content.info as { mimetype?: string; size?: number } | undefined;
  return {
    eventId,
    senderId,
    body: content.body,
    createdAt: new Date(event.getTs()).toISOString(),
    status: 'delivered',
    file: file?.url
      ? {
          encryptedFile: { ...file, url: file.url },
          mimeType: info?.mimetype || 'application/octet-stream',
          name: content.body,
          size: info?.size || 0,
        }
      : undefined,
  };
}

export async function listMatrixMessages(
  conversationId: string,
  limit = 50,
): Promise<MatrixMessage[]> {
  const client = await getMatrixClient();
  const roomId = await ensureMatrixRoom(conversationId);
  const room = client.getRoom(roomId);
  if (!room) return [];

  const events = room.getLiveTimeline().getEvents().slice(-limit);
  const messages: MatrixMessage[] = [];
  for (const event of events) {
    await client.decryptEventIfNeeded(event);
    const mapped = contentToMessage(event);
    if (mapped) messages.push(mapped);
  }
  return messages;
}

export async function sendMatrixText(
  conversationId: string,
  body: string,
): Promise<string> {
  const client = await getMatrixClient();
  const roomId = await ensureMatrixRoom(conversationId);
  const result = await client.sendTextMessage(roomId, body);
  return result.event_id;
}

export async function sendMatrixAttachment(
  conversationId: string,
  file: File,
): Promise<string> {
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('MATRIX_ATTACHMENT_SIZE_INVALID');
  }

  const client = await getMatrixClient();
  const roomId = await ensureMatrixRoom(conversationId);
  const encrypted = await encryptAttachment(await file.arrayBuffer());
  const upload = await client.uploadContent(
    new Blob([encrypted.data], { type: 'application/octet-stream' }),
    { name: `${crypto.randomUUID()}.bin`, type: 'application/octet-stream' },
  );

  const msgtype = file.type.startsWith('image/')
    ? 'm.image'
    : file.type.startsWith('video/')
      ? 'm.video'
      : file.type.startsWith('audio/')
        ? 'm.audio'
        : 'm.file';
  const content = {
    msgtype,
    body: file.name,
    file: { ...encrypted.info, url: upload.content_uri },
    info: { mimetype: file.type || 'application/octet-stream', size: file.size },
  };
  const result = await client.sendEvent(
    roomId,
    ROOM_MESSAGE_EVENT,
    content as unknown as RoomMessageEventContent,
  );
  return result.event_id;
}

export async function downloadMatrixAttachment(
  encryptedFile: IEncryptedFile & { url: string },
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; objectUrl: string }> {
  const client = await getMatrixClient();
  const url = client.mxcUrlToHttp(
    encryptedFile.url,
    undefined,
    undefined,
    undefined,
    false,
    true,
    true,
  );
  const token = client.getAccessToken();
  if (!url || !token) throw new Error('MATRIX_MEDIA_ROUTE_UNAVAILABLE');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`MATRIX_MEDIA_DOWNLOAD_${response.status}`);

  const plaintext = await decryptAttachment(await response.arrayBuffer(), encryptedFile);
  const blob = new Blob([plaintext], { type: mimeType });
  return { blob, objectUrl: URL.createObjectURL(blob) };
}

export async function subscribeMatrixMessages(
  conversationId: string,
  callback: (message: MatrixMessage) => void,
): Promise<() => void> {
  const client = await getMatrixClient();
  const roomId = await ensureMatrixRoom(conversationId);
  const handler = async (event: MatrixEvent): Promise<void> => {
    if (event.getRoomId() !== roomId) return;
    await client.decryptEventIfNeeded(event);
    const mapped = contentToMessage(event);
    if (mapped) callback(mapped);
  };
  client.on(ROOM_TIMELINE_EVENT, handler);
  return () => client.removeListener(ROOM_TIMELINE_EVENT, handler);
}
