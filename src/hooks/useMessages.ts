import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useEffect } from 'react';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';
import { isCryptoJsonBody, isUnsupportedEncryptedBody, isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { clearNegativeCache, resolvePlaintext, persistOutcome } from '@/components/messages/decryptionService';
import { sendSesameLiteMessage } from '@/lib/messaging/sendSesameLiteMessage';
import type { Database } from '@/integrations/supabase/types';

type MessageRow = Database['public']['Tables']['messages']['Row'];
type MessageDeviceCopyRow = Database['public']['Tables']['message_device_copies']['Row'];
type ProfileSummary = Pick<Database['public']['Tables']['profiles']['Row'], 'name' | 'avatar_url'>;

async function hideMessagesForUser(userId: string, messageIds: string[]) {
  if (!userId || messageIds.length === 0) return;
  const rows = messageIds.map((message_id) => ({ message_id, user_id: userId }));
  const { error } = await supabase.from('message_deletions').insert(rows);
  if (error && error.code !== '23505') throw error;
}

async function repairConversationHiddenMessages(
  userId: string,
  conversationId: string,
  messages: Array<{ id: string; conversation_id: string; body: string | null }>,
  hiddenIds: Set<string>,
): Promise<boolean> {
  if (!userId || !conversationId || messages.length === 0) return false;

  const hiddenConversationMessages = messages.filter((m) => hiddenIds.has(m.id));
  const visibleConversationMessages = messages.filter((m) => !hiddenIds.has(m.id));
  const hasCryptoRows = messages.some((m) => isCryptoJsonBody(m.body));

  // Auto-cleanup used to persist crypto failures as "delete for me". When a
  // returning session finds every fetched row hidden, prefer restoring the
  // conversation over showing an empty chat. Manual single-message deletions
  // remain untouched because this only repairs the all-hidden failure mode.
  if (
    visibleConversationMessages.length > 0 ||
    hiddenConversationMessages.length !== messages.length ||
    !hasCryptoRows
  ) {
    return false;
  }

  const ids = hiddenConversationMessages.map((m) => m.id);
  const { error } = await supabase
    .from('message_deletions')
    .delete()
    .eq('user_id', userId)
    .in('message_id', ids);

  if (error) {
    console.warn('[messaging] failed to repair hidden conversation messages:', error.message);
    return false;
  }

  ids.forEach((id) => hiddenIds.delete(id));
  console.warn('[messaging] restored hidden messages after session return', {
    conversationId,
    count: ids.length,
  });
  return true;
}

export const ZEUS_BOT_ID = '00000000-0000-0000-0000-000000000001';

/** Build the scoped messages query key. Must mirror the key used in useMessages(). */
const messagesKey = (conversationId: string, userId: string | undefined) =>
  ['messages', conversationId, userId ?? 'anon'] as const;

function isMultiDeviceMessageRow(message: { body?: string | null; body_kind?: string | null }): boolean {
  return Boolean(message.body && isMultiDeviceEnvelopeBody(message.body));
}

let keysRestoredConversationRefetchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKeysRestoredConversationRefetch(queryClient: QueryClient) {
  if (keysRestoredConversationRefetchTimer) return;
  keysRestoredConversationRefetchTimer = setTimeout(() => {
    keysRestoredConversationRefetchTimer = null;
    console.log('[messaging] keys restored - refetch conversations');
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, 350);
}

// Helper to get the user's custom AI companion name
async function getCompanionName(userId?: string): Promise<string> {
  if (!userId) return 'Zeus ⚡';
  try {
    const { data } = await supabase
      .from('zeus_user_settings')
      .select('custom_name')
      .eq('user_id', userId)
      .maybeSingle();
    const name = data?.custom_name?.trim();
    return name ? `${name} ⚡` : 'Zeus ⚡';
  } catch {
    return 'Zeus ⚡';
  }
}

// Send a message to Zeus via the agent-chat edge function, which handles
// inserting both the user message and Zeus response into the regular messenger
async function sendToZeus(userId: string, messengerConvId: string, body: string) {
  // First insert the user's message into the messenger
  const { data: userMsg, error: msgErr } = await supabase
    .from('messages')
    .insert({
      conversation_id: messengerConvId,
      sender_id: userId,
      body,
      body_kind: 'system',
      status: 'delivered',
    })
    .select()
    .single();
  if (msgErr) throw msgErr;

  // Get Zeus agent ID
  const { data: agent } = await supabase
    .from('ai_agents')
    .select('id')
    .eq('slug', 'zeus-companion')
    .eq('is_active', true)
    .single();
  if (!agent) return userMsg;

  // Get or create a Zeus AI conversation for context
  const { data: existingConv } = await supabase
    .from('ai_agent_conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('agent_id', agent.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const zeusConvId = existingConv?.id || null;

  // Call agent-chat (fire and forget - response will be pushed to messenger by the edge function)
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    supabase.functions.invoke('agent-chat', {
      body: { agent_id: agent.id, conversation_id: zeusConvId, message: body },
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch(err => console.error('Zeus messenger reply failed:', err));
  }

  // Update conversation timestamp
  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', messengerConvId);

  return userMsg;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  body_kind?: string | null;
  image_url: string | null;
  created_at: string;
  status: 'delivered' | 'pending' | 'blocked';
  profile: {
    name: string;
    avatar_url: string | null;
  };
}

export interface Conversation {
  id: string;
  created_at: string;
  updated_at: string;
  is_group: boolean;
  name: string | null;
  created_by?: string | null;
  participant: {
    user_id: string;
    name: string;
    avatar_url: string | null;
  };
  participants?: {
    user_id: string;
    name: string;
    avatar_url: string | null;
  }[];
  last_message?: {
    body: string;
    created_at: string;
    sender_id: string;
  };
  unread_count: number;
}

export function useConversations() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Force a refetch whenever the auth user changes (login, refresh, multi-tab).
  // Without this, a first run while user=null caches an empty list under the
  // shared key ['conversations'] and the UI stays empty forever.
  useEffect(() => {
    if (!user?.id) return;
    const onRestored = () => {
      scheduleKeysRestoredConversationRefetch(queryClient);
    };
    window.addEventListener('forsure-keys-restored', onRestored);
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    return () => window.removeEventListener('forsure-keys-restored', onRestored);
  }, [user?.id, queryClient]);

  return useQuery({
    // Scope the cache to the user id so a stale empty list from a logged-out
    // run never leaks into a logged-in session.
    queryKey: ['conversations', user?.id ?? 'anon'],
    queryFn: async () => {
      if (!user) return [];
      console.log('[messaging] fetching conversations for', user.id);

      // ── Single RPC: conversations + participants + last message + unread ──
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_conversations_with_details', {
          p_user_id: user.id,
        });

        if (rpcError) {
          console.warn('[messaging] RPC get_conversations_with_details failed, will fallback:', rpcError.message);
        }

        // Use RPC result whenever it returned without error, even if empty —
        // an empty result from a healthy RPC means the user genuinely has 0
        // conversations. Only fall back when the RPC itself errored.
        if (!rpcError && rpcData) {
          console.log('[messaging] conversations from RPC:', rpcData.length);
          if (rpcData.length === 0) return [];
          return rpcData.map((row) => ({
            id: row.conv_id,
            created_at: row.conv_created_at,
            updated_at: row.conv_updated_at,
            is_group: row.is_group || false,
            name: row.conv_name || null,
            created_by: row.created_by || null,
            participant: {
              user_id: row.other_user_id || '',
              name: row.other_name || 'Unknown',
              avatar_url: row.other_avatar || null,
            },
            participants: undefined,
            last_message: row.last_message_body ? {
              body: isUnsupportedEncryptedBody(row.last_message_body) ? '🧹 Message incompatible supprimé' : row.last_message_body,
              created_at: row.last_message_at,
              sender_id: row.last_message_sender,
            } : undefined,
            unread_count: Number(row.unread_count) || 0,
          })) as Conversation[];
        }
      } catch {
        // Fall through to legacy queries
      }

      // ── Fallback: original multi-query approach ──
      const { data: participations, error: partError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, last_read_at')
        .eq('user_id', user.id);

      if (partError) throw partError;
      if (!participations?.length) return [];

      const conversationIds = participations.map(p => p.conversation_id);
      const lastReadMap = new Map(participations.map(p => [p.conversation_id, p.last_read_at]));

      const [convRes, partRes] = await Promise.all([
        supabase.from('conversations').select('*').in('id', conversationIds).order('updated_at', { ascending: false }),
        supabase.from('conversation_participants').select('conversation_id, user_id').in('conversation_id', conversationIds).neq('user_id', user.id),
      ]);

      const conversations = convRes.data;
      const allParticipants = partRes.data;
      if (!conversations) return [];

      const otherUserIds = [...new Set(allParticipants?.map(p => p.user_id) || [])];
      const { data: profiles } = await supabase.from('profiles').select('user_id, name, avatar_url').in('user_id', otherUserIds);
      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);
      if (!profileMap.has(ZEUS_BOT_ID) && otherUserIds.includes(ZEUS_BOT_ID)) {
        const companionName = await getCompanionName(user.id);
        profileMap.set(ZEUS_BOT_ID, { user_id: ZEUS_BOT_ID, name: companionName, avatar_url: null });
      }

      // Count unread messages properly per conversation
      const { data: unreadData } = await supabase
        .from('messages')
        .select('conversation_id, created_at, sender_id')
        .in('conversation_id', conversationIds)
        .neq('sender_id', user.id)
        .eq('status', 'delivered');

      const unreadCounts: Record<string, number> = {};
      unreadData?.forEach(m => {
        const lastRead = lastReadMap.get(m.conversation_id);
        if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
          unreadCounts[m.conversation_id] = (unreadCounts[m.conversation_id] || 0) + 1;
        }
      });

      // Get last message per conversation
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('id, conversation_id, body, created_at, sender_id')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false })
        .limit(conversationIds.length);

      // Note: incompatible messages are filtered locally — no DB write during fetch.
      const lastMessageMap = new Map<string, { body: string; created_at: string; sender_id: string }>();
      recentMessages?.forEach(m => {
        if (!lastMessageMap.has(m.conversation_id) && !isUnsupportedEncryptedBody(m.body)) lastMessageMap.set(m.conversation_id, m);
      });

      return conversations.map(conv => {
        const convParts = (allParticipants || [])
          .filter(p => p.conversation_id === conv.id)
          .map(p => ({ user_id: p.user_id, name: profileMap.get(p.user_id)?.name || 'Unknown', avatar_url: profileMap.get(p.user_id)?.avatar_url || null }));

        return {
          id: conv.id,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          is_group: conv.is_group || false,
          name: conv.name || null,
          created_by: conv.created_by || null,
          participant: convParts[0] || { user_id: '', name: 'Unknown', avatar_url: null },
          participants: conv.is_group ? convParts : undefined,
          last_message: lastMessageMap.get(conv.id),
          unread_count: unreadCounts[conv.id] || 0,
        } as Conversation;
      });
    },
    enabled: !!user,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    // Force a refetch on mount + when the network reconnects so a returning
    // user always sees the server-side truth, never an old cached empty list.
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: false,
  });
}

export function useMessages(conversationId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!conversationId || !user) return;

    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const newMsg = payload.new as MessageRow;
          if (isUnsupportedEncryptedBody(newMsg.body)) {
            console.warn('[messaging] ignoring unsupported encrypted message without hiding it', newMsg.id);
            return;
          }

          // Fetch profile for sender (use cache first)
          let profile = queryClient.getQueryData<ProfileSummary>(['profile', newMsg.sender_id]);
          if (!profile) {
            const { data: p } = await supabase
              .from('profiles')
              .select('user_id, name, avatar_url')
              .eq('user_id', newMsg.sender_id)
              .single();
            profile = p;
          }

          const enriched: Message = {
            ...newMsg,
            status: newMsg.status as Message['status'],
            profile: {
              name: newMsg.sender_id === ZEUS_BOT_ID ? (await getCompanionName(user?.id)) : (profile?.name || 'Unknown'),
              avatar_url: profile?.avatar_url || null,
            },
          };

          // Inject directly into cache — replaces optimistic messages and prevents duplicates
          queryClient.setQueryData<Message[]>(
            messagesKey(conversationId, user?.id),
            (old) => {
              if (!old) return [enriched];
              // Remove any optimistic message for this real one, and prevent duplicates
              const filtered = old.filter(m =>
                m.id !== enriched.id && !m.id.startsWith('optimistic-')
              );
              // Only skip if already present with same id
              if (old.some(m => m.id === enriched.id)) return old;
              return [...filtered, enriched];
            }
          );

          // Update conversation last_updated (lightweight)
          queryClient.invalidateQueries({ queryKey: ['conversations'] });

          // Sesame-lite has one receive path: resolve the copy addressed to
          // this device. The sibling realtime subscription below wakes the
          // bubble if websocket events from the same transaction arrive out
          // of order, so no polling loop or legacy router is needed here.
          if (user && isMultiDeviceMessageRow(newMsg)) {
            void resolvePlaintext({
              body: newMsg.body,
              messageId: newMsg.id,
              senderId: newMsg.sender_id,
              decrypt: async () => ({ text: '', incompatible: true, encrypted: true, verified: false }),
            }).then((outcome) => {
              if (!outcome || outcome.hidden) return;
              persistOutcome(newMsg.body, outcome, newMsg.id);
              try {
                window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
                  detail: { messageId: newMsg.id },
                }));
              } catch { /* SSR */ }
            }).catch(() => {});
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_device_copies',
          filter: `recipient_user_id=eq.${user.id}`,
        },
        (payload) => {
          const messageId = (payload.new as Partial<MessageDeviceCopyRow>).message_id;
          if (messageId) {
            try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { messageId } })); } catch { /* SSR */ }
            return;
          }
          clearNegativeCache();
          try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch { /* SSR */ }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const deletedId = (payload.old as Partial<MessageRow>).id;
          if (deletedId) {
            queryClient.setQueryData<Message[]>(
              messagesKey(conversationId, user?.id),
              (old) => old?.filter(m => m.id !== deletedId) || []
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, user, queryClient]);

  useEffect(() => {
    if (!conversationId) return;

    const handleCleaned = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId !== conversationId) return;
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    };

    window.addEventListener('forsure-conversation-cleaned', handleCleaned as EventListener);
    return () => window.removeEventListener('forsure-conversation-cleaned', handleCleaned as EventListener);
  }, [conversationId, queryClient]);

  // Background cleanup: keep this non-destructive. Older builds inserted
  // message_deletions here, which could make a whole chat look empty after
  // returning to a session if a crypto envelope was misclassified.
  useEffect(() => {
    if (!conversationId || !user) return;
    let cancelled = false;
    (async () => {
      const { data: msgs } = await supabase
        .from('messages')
        .select('id, body')
        .eq('conversation_id', conversationId)
        .in('status', ['delivered', 'pending'])
        .order('created_at', { ascending: false })
        .limit(120);
      if (cancelled || !msgs) return;
      const ids = msgs.filter(m => isUnsupportedEncryptedBody(m.body)).map(m => m.id);
      if (ids.length > 0) {
        console.warn('[messaging] unsupported encrypted messages left visible for recovery', {
          conversationId,
          count: ids.length,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, user]);

  const messagesQuery = useQuery({
    // Scope by user so the cache is never shared across accounts/sessions.
    queryKey: ['messages', conversationId, user?.id ?? 'anon'],
    queryFn: async () => {
      if (!conversationId || !user) return [];
      console.log('[messaging] fetching messages for conversation', conversationId);

      // Get hidden message IDs for this user
      const { data: deletions } = await supabase
        .from('message_deletions')
        .select('message_id')
        .eq('user_id', user.id);

      const hiddenIds = new Set((deletions || []).map(d => d.message_id));

      // Load the recent window first. Older messages should be paged by scroll,
      // not decrypted in bulk on mobile startup.
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .in('status', ['delivered', 'pending'])
        .order('created_at', { ascending: false })
        .limit(120);

      if (error) {
        console.error('[messaging] message fetch failed:', error.message);
        throw error;
      }
      console.log('[messaging] loaded', messages.length, 'messages from server');

      // Reverse to chronological order for display
      messages.reverse();

      const repairedHiddenRows = await repairConversationHiddenMessages(
        user.id,
        conversationId,
        messages,
        hiddenIds,
      );
      if (repairedHiddenRows) {
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }

      // Filter out hidden + incompatible messages locally — no DB writes here.
      const visibleMessages = messages.filter(m => !hiddenIds.has(m.id));
      const compatibleMessages = visibleMessages.filter(m => !isUnsupportedEncryptedBody(m.body));

      // Warm only recent Sesame-lite device copies after a cold reload. Older
      // messages resolve lazily when mounted during scroll.
      if (user) {
        const decryptTasks = compatibleMessages
          .slice(-24)
          .filter(isMultiDeviceMessageRow)
          .map(async (m) => {
            try {
              const outcome = await resolvePlaintext({
                body: m.body,
                messageId: m.id,
                senderId: m.sender_id,
                decrypt: async () => ({ text: '', incompatible: true, encrypted: true, verified: false }),
              });
              if (!outcome || outcome.hidden) return false;
              persistOutcome(m.body, outcome, m.id);
              return true;
            } catch {
              return false;
            }
          });

        const results = await Promise.all(decryptTasks);
        if (results.some(Boolean) && typeof window !== 'undefined') {
          try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch { /* SSR */ }
        }
      }

      const senderIds = [...new Set(compatibleMessages.map(m => m.sender_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', senderIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      const hasZeusMessages = compatibleMessages.some(m => m.sender_id === ZEUS_BOT_ID);
      const companionDisplayName = hasZeusMessages ? await getCompanionName(user?.id) : 'Zeus ⚡';

      return compatibleMessages.map(msg => ({
        ...msg,
        profile: {
          name: msg.sender_id === ZEUS_BOT_ID ? companionDisplayName : (profileMap.get(msg.sender_id)?.name || 'Unknown'),
          avatar_url: profileMap.get(msg.sender_id)?.avatar_url || null,
        },
      })) as Message[];
    },
    enabled: !!conversationId && !!user,
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: false,
  });

  return messagesQuery;
}

/**
 * Shared send hook for features outside the main composer. Zeus remains the
 * only plaintext path; every peer message uses the same Sesame-lite transport
 * as ChatView and ChatWidget.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ conversationId, body, imageUrl }: { conversationId: string; body: string; imageUrl?: string }) => {
      if (!user) throw new Error('Not authenticated');

      // Check if this is a Zeus / bot conversation (whitelisted plaintext path).
      const { data: zeusParticipant } = await supabase
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', ZEUS_BOT_ID)
        .maybeSingle();

      const isBotConversation = !!zeusParticipant;

      if (isBotConversation) {
        return await sendToZeus(user.id, conversationId, body);
      }

      // Anti-spam validation (skip for voice/image-only messages)
      const isSpecialMessage = body.startsWith('🎙️ voice:') || body === '📷 Image';
      if (!isSpecialMessage) {
        const validation = validateMessage(body);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
      }

      const sanitizedBody = isSpecialMessage ? body : sanitizeMessageBody(body);

      let sent: Awaited<ReturnType<typeof sendSesameLiteMessage>>;
      try {
        sent = await sendSesameLiteMessage({
          conversationId,
          senderUserId: user.id,
          plaintext: sanitizedBody,
          imageUrl: imageUrl ?? null,
        });
      } catch {
        throw new Error('Message non envoyé — chiffrement non disponible.');
      }

      if (!isSpecialMessage) recordSentMessage(sanitizedBody);

      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      return {
        id: sent.id,
        conversation_id: conversationId,
        sender_id: user.id,
        body: sent.parentBody,
      };
    },
    // Optimistic update: immediately show sent message in UI
    onMutate: async (variables) => {
      if (!user) return;

      const key = messagesKey(variables.conversationId, user.id);
      await queryClient.cancelQueries({ queryKey: key });

      const previousMessages = queryClient.getQueryData<Message[]>(key);

      const profile = queryClient.getQueryData<ProfileSummary>(['profile', user.id]);
      const optimisticMessage: Message = {
        id: `optimistic-${Date.now()}`,
        conversation_id: variables.conversationId,
        sender_id: user.id,
        body: variables.body,
        image_url: variables.imageUrl || null,
        created_at: new Date().toISOString(),
        status: 'delivered',
        profile: {
          name: profile?.name || user.user_metadata?.name || 'Moi',
          avatar_url: profile?.avatar_url || null,
        },
      };

      queryClient.setQueryData<Message[]>(
        key,
        (old) => [...(old || []), optimisticMessage]
      );

      return { previousMessages };
    },
    onError: (_err, variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(messagesKey(variables.conversationId, user?.id), context.previousMessages);
      }
    },
    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

// Delete message for me only (hide it)
export function useDeleteMessageForMe() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    onMutate: async ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
      const key = messagesKey(conversationId, user?.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previousMessages = queryClient.getQueryData<Message[]>(key);

      queryClient.setQueryData<Message[]>(
        key,
        (old) => old?.filter(m => m.id !== messageId) || []
      );

      return { previousMessages, conversationId };
    },
    mutationFn: async ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('message_deletions')
        .insert({ message_id: messageId, user_id: user.id });

      // Déjà supprimé côté utilisateur -> considérer comme succès idempotent
      if (error && error.code !== '23505') throw error;
      return conversationId;
    },
    onError: (_err, _vars, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(messagesKey(context.conversationId, user?.id), context.previousMessages);
      }
    },
    onSuccess: (conversationId) => {
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

// Delete message for everyone (only sender can do this)
export function useDeleteMessageForEveryone() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    onMutate: async ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
      const key = messagesKey(conversationId, user?.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previousMessages = queryClient.getQueryData<Message[]>(key);

      queryClient.setQueryData<Message[]>(
        key,
        (old) => old?.filter(m => m.id !== messageId) || []
      );

      return { previousMessages, conversationId };
    },
    mutationFn: async ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)
        .eq('sender_id', user.id);

      if (error) throw error;
      return conversationId;
    },
    onError: (_err, _vars, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(messagesKey(context.conversationId, user?.id), context.previousMessages);
      }
    },
    onSuccess: (conversationId) => {
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (otherUserId: string) => {
      if (!user) throw new Error('Not authenticated');
      if (!otherUserId) throw new Error('Invalid peer');

      // Atomic server-side creation: either returns the existing 1-to-1
      // conversation between the two users, or creates a fresh one with
      // both participants in a single transaction. No client-side inserts
      // into conversation_participants — RLS forbids it.
      const { data, error } = await supabase.rpc('create_or_get_dm_conversation', {
        p_other_user: otherUserId,
      });
      if (error) throw error;
      if (!data) throw new Error('Failed to create conversation');
      return { id: data as string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useCreateGroupConversation() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ name, memberIds }: { name: string; memberIds: string[] }) => {
      if (!user) throw new Error('Not authenticated');
      if (!name.trim()) throw new Error('Nom du groupe requis');
      if (memberIds.length < 2) throw new Error('Ajoutez au moins 2 amis');

      const { data, error } = await supabase.rpc('create_group_conversation', {
        p_name: name.trim(),
        p_member_ids: memberIds,
      });
      if (error) throw error;
      if (!data) throw new Error('Failed to create group');
      return { id: data as string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useMarkConversationRead() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('conversation_participants')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

// Check if a conversation has pending (non-friend) messages
export function useHasPendingMessages(conversationId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['pending-messages', conversationId],
    queryFn: async () => {
      if (!conversationId || !user) return false;

      const { data } = await supabase
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('status', 'pending')
        .neq('sender_id', user.id)
        .limit(1);

      return (data?.length || 0) > 0;
    },
    enabled: !!conversationId && !!user,
  });
}

// Accept a message request (deliver all pending messages)
export function useAcceptMessageRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: { domain: 'moderation', action: 'accept_request', conversationId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['pending-messages'] });
    },
  });
}

// Reject a message request (block all pending messages)
export function useRejectMessageRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: { domain: 'moderation', action: 'reject_request', conversationId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['pending-messages'] });
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      if (!user) throw new Error('Not authenticated');

      // Remove self from conversation participants (soft delete)
      const { error } = await supabase
        .from('conversation_participants')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useLeaveGroup() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('conversation_participants')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useAddGroupMembers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ conversationId, memberIds }: { conversationId: string; memberIds: string[] }) => {
      // Server-side: only the group admin (created_by) can add members.
      const { error } = await supabase.rpc('add_group_members', {
        p_conv_id: conversationId,
        p_member_ids: memberIds,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useRemoveGroupMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ conversationId, userId }: { conversationId: string; userId: string }) => {
      const { error } = await supabase
        .from('conversation_participants')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useGroupMembers(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['group-members', conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const { data, error } = await supabase
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', conversationId);
      if (error) throw error;
      
      const userIds = data.map(d => d.user_id);
      if (userIds.length === 0) return [];
      
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);
      if (pErr) throw pErr;
      return profiles || [];
    },
    enabled: !!conversationId,
  });
}
