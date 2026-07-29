import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { safeUUID } from '@/e2ee-session';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { sendAegisOutboundMessage } from '@/lib/messaging/aegisOutboundEngine';
import {
  deleteOutboxPayload,
  getOutboxPayload,
  listOutboxPayloads,
  putOutboxPayload,
  type OutboxExtra,
  type OutboxPayload,
  type OutboxStatus,
} from '@/lib/messaging/outboxVault';

export interface OutboundMessage {
  localId: string;
  traceId: string;
  conversationId: string;
  senderId: string;
  plaintext: string;
  encryptedBody: string | null;
  imageUrl: string | null;
  status: OutboxStatus;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  serverId: string | null;
}

type SentMessageSnapshot = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  body_kind: 'server';
  archive_body: null;
  aegis_route_version: null;
  image_url: string | null;
  created_at: string;
  status: 'delivered';
  profile: {
    name: string;
    avatar_url: string | null;
  };
};

function inferBody(body: string, imageUrl?: string | null): string {
  const trimmed = body.trim();
  if (trimmed) return body;
  if (!imageUrl) return '';
  const lower = imageUrl.toLowerCase().split('?')[0];
  if (lower.endsWith('.gif') || lower.includes('image/gif')) return '🎞️ GIF';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.includes('video')) return '🎬 Vidéo';
  return '📷 Photo';
}

function isSpecialMessage(body: string, imageUrl?: string | null): boolean {
  return Boolean(imageUrl)
    || body.includes('\x00MKEY:')
    || body.startsWith('🎙️ voice:')
    || body.startsWith('🎙️ vocal:')
    || body.startsWith('📞 CALL:')
    || body.startsWith('GIF:')
    || body === '📷 Photo'
    || body === '🎬 Vidéo'
    || body === '🎞️ GIF';
}

function toOutbound(payload: OutboxPayload): OutboundMessage {
  const status = payload.status === 'sent'
    || payload.status === 'sending'
    || payload.status === 'encrypting'
    || payload.status === 'waiting_secure_channel'
      ? 'retry_pending'
      : payload.status;

  return {
    localId: payload.localId,
    traceId: payload.traceId,
    conversationId: payload.conversationId,
    senderId: payload.senderId,
    plaintext: payload.plaintext,
    encryptedBody: null,
    imageUrl: payload.imageUrl,
    status,
    retryCount: payload.retryCount,
    maxRetries: Math.min(payload.maxRetries || 3, 3),
    lastError: payload.lastError ?? 'Envoi restauré après redémarrage.',
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    serverId: payload.reservedServerId,
  };
}

function scheduleConversationRefresh(queryClient: ReturnType<typeof useQueryClient>): void {
  window.setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, 750);
}

/**
 * Durable queue for the server-readable message transport.
 *
 * One stable UUID is reserved before transport. Every retry reuses it, and the
 * database RPC returns the existing row when the first response was lost.
 * Device registration, peer keys, Signed PreKeys and fan-out are not consulted.
 */
export function useServerMessageQueue(
  conversationId: string,
  onPlaintextCached?: (serverId: string, plaintext: string) => void,
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pendingMessages, setPendingMessages] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPendingMessages([]);
    if (!user?.id || !conversationId) return;

    void (async () => {
      const payloads = await listOutboxPayloads(user.id, conversationId);
      const reservedIds = payloads
        .map((payload) => payload.reservedServerId)
        .filter((id): id is string => Boolean(id));
      const delivered = new Set<string>();

      if (reservedIds.length > 0) {
        const { data } = await supabase
          .from('messages')
          .select('id')
          .in('id', reservedIds);
        for (const row of data ?? []) delivered.add(row.id);
      }

      const restored: OutboundMessage[] = [];
      for (const payload of payloads) {
        if (payload.reservedServerId && delivered.has(payload.reservedServerId)) {
          await deleteOutboxPayload(payload.localId).catch(() => undefined);
          continue;
        }
        // Old Aegis preparation is deliberately ignored. The compatibility
        // engine clears ciphertext/copies before the stable server retry.
        restored.push(toOutbound({
          ...payload,
          encryptedBody: null,
          keyCapsule: null,
          preparedCopies: [],
          routeVersion: null,
          archiveBackupEnabled: false,
          archiveBody: null,
          maxRetries: 3,
        }));
      }

      if (!cancelled) {
        setPendingMessages(restored.sort(
          (a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId),
        ));
      }
    })().catch((error) => {
      console.warn('[SERVER-OUTBOX] restore failed', error);
    });

    return () => { cancelled = true; };
  }, [conversationId, user?.id]);

  const sendMessage = useCallback(async (
    body: string,
    imageUrl?: string | null,
    extra?: OutboxExtra,
    resumePayload?: OutboxPayload,
  ) => {
    if (!user?.id) throw new Error('Session expirée — reconnectez-vous pour envoyer.');

    const effectiveBody = inferBody(body, imageUrl);
    if (!effectiveBody.trim() && !imageUrl) return;
    if (resumePayload && resumePayload.conversationId !== conversationId) {
      throw new Error('Outbox conversation mismatch.');
    }

    const special = isSpecialMessage(effectiveBody, imageUrl);
    if (!special) {
      const validation = validateMessage(effectiveBody);
      if (!validation.valid) throw new Error(validation.error);
    }
    const plaintext = special ? effectiveBody : sanitizeMessageBody(effectiveBody);

    const now = resumePayload?.createdAt ?? Date.now();
    const localId = resumePayload?.localId
      ?? `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = resumePayload?.traceId ?? safeUUID();
    const messageId = resumePayload?.reservedServerId ?? safeUUID();
    const retryCount = resumePayload ? Math.min(resumePayload.retryCount + 1, 3) : 0;

    let snapshot: OutboxPayload = {
      ...(resumePayload ?? {}),
      localId,
      traceId,
      conversationId,
      senderId: user.id,
      plaintext,
      transportPlaintext: plaintext,
      encryptedBody: null,
      keyCapsule: null,
      preparedCopies: [],
      routeVersion: null,
      archiveBackupEnabled: false,
      archiveBody: null,
      imageUrl: imageUrl ?? null,
      extra: extra ?? resumePayload?.extra,
      status: 'pending_local',
      retryCount,
      maxRetries: 3,
      lastError: null,
      createdAt: now,
      updatedAt: Date.now(),
      reservedServerId: messageId,
    };

    const optimistic = toOutbound(snapshot);
    optimistic.status = 'sending';
    optimistic.lastError = null;
    setPendingMessages((current) => [
      ...current.filter((message) => message.localId !== localId),
      optimistic,
    ]);

    try {
      const sent = await sendAegisOutboundMessage({
        conversationId,
        senderUserId: user.id,
        plaintext,
        imageUrl: imageUrl ?? null,
        extra: snapshot.extra,
        localId,
        traceId,
        messageId,
        createdAt: now,
        resumePayload: snapshot,
        onState: (next) => {
          snapshot = next;
          setPendingMessages((current) => current.map((message) =>
            message.localId === localId
              ? {
                  ...message,
                  status: next.status,
                  retryCount: next.retryCount,
                  maxRetries: 3,
                  lastError: next.lastError,
                  updatedAt: next.updatedAt,
                  serverId: next.reservedServerId,
                  encryptedBody: null,
                }
              : message,
          ));
        },
      });

      if (!special) recordSentMessage(plaintext);
      onPlaintextCached?.(sent.id, plaintext);

      const sentMessage: SentMessageSnapshot = {
        id: sent.id,
        conversation_id: conversationId,
        sender_id: user.id,
        body: plaintext,
        body_kind: 'server',
        archive_body: null,
        aegis_route_version: null,
        image_url: imageUrl ?? null,
        created_at: new Date().toISOString(),
        status: 'delivered',
        profile: {
          name: user.user_metadata?.name || user.user_metadata?.full_name || user.email || 'Moi',
          avatar_url: user.user_metadata?.avatar_url || null,
        },
      };

      const upsert = (old: SentMessageSnapshot[] | undefined) => {
        if (!Array.isArray(old)) return [sentMessage];
        if (old.some((message) => message?.id === sent.id)) return old;
        return [...old, sentMessage];
      };
      queryClient.setQueryData<SentMessageSnapshot[]>(
        ['messages', conversationId, user.id],
        upsert,
      );
      queryClient.setQueriesData<SentMessageSnapshot[]>(
        { queryKey: ['messages', conversationId] },
        upsert,
      );

      setPendingMessages((current) => current.filter((message) => message.localId !== localId));
      scheduleConversationRefresh(queryClient);
    } catch (error) {
      // The engine already persisted the exact status and stable UUID. Keep the
      // visible bubble so the bounded scheduler or manual retry can resume it.
      throw error instanceof Error ? error : new Error('Échec de l’envoi.');
    }
  }, [conversationId, onPlaintextCached, queryClient, user]);

  const retryMessage = useCallback(async (localId: string) => {
    if (!user?.id) return;
    const payload = await getOutboxPayload(user.id, localId);
    if (!payload) {
      setPendingMessages((current) => current.filter((message) => message.localId !== localId));
      return;
    }

    if (payload.reservedServerId) {
      const { data } = await supabase
        .from('messages')
        .select('id')
        .eq('id', payload.reservedServerId)
        .maybeSingle();
      if (data?.id) {
        await deleteOutboxPayload(localId).catch(() => undefined);
        setPendingMessages((current) => current.filter((message) => message.localId !== localId));
        return;
      }
    }

    await sendMessage(payload.plaintext, payload.imageUrl, payload.extra, {
      ...payload,
      encryptedBody: null,
      keyCapsule: null,
      preparedCopies: [],
      routeVersion: null,
      archiveBackupEnabled: false,
      archiveBody: null,
      maxRetries: 3,
    });
  }, [sendMessage, user?.id]);

  const removeMessage = useCallback(async (localId: string) => {
    await deleteOutboxPayload(localId).catch(() => undefined);
    setPendingMessages((current) => current.filter((message) => message.localId !== localId));
  }, []);

  const markRetryExhausted = useCallback(async (localId: string) => {
    const lastError = 'Envoi interrompu après trois tentatives. Appuyez sur Réessayer.';
    const updatedAt = Date.now();
    setPendingMessages((current) => current.map((message) =>
      message.localId === localId
        ? { ...message, status: 'failed_visible', lastError, updatedAt }
        : message,
    ));

    if (!user?.id) return;
    const payload = await getOutboxPayload(user.id, localId).catch(() => null);
    if (!payload) return;
    await putOutboxPayload(user.id, {
      ...payload,
      encryptedBody: null,
      keyCapsule: null,
      preparedCopies: [],
      routeVersion: null,
      status: 'failed_visible',
      maxRetries: 3,
      lastError,
      updatedAt,
    }).catch(() => undefined);
  }, [user?.id]);

  return {
    pendingMessages,
    sendMessage,
    retryMessage,
    markRetryExhausted,
    removeMessage,
    isInstant: true,
  };
}
