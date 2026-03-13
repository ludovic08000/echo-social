import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useEffect } from 'react';
import { validateMessage, recordSentMessage, sanitizeMessageBody } from '@/lib/messageAntiSpam';

export const ZEUS_BOT_ID = '00000000-0000-0000-0000-000000000001';

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

  return useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      if (!user) return [];

      const { data: participations, error: partError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, last_read_at')
        .eq('user_id', user.id);

      if (partError) throw partError;
      if (!participations?.length) return [];

      const conversationIds = participations.map(p => p.conversation_id);
      const lastReadMap = new Map(participations.map(p => [p.conversation_id, p.last_read_at]));

      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select('*')
        .in('id', conversationIds)
        .order('updated_at', { ascending: false });

      if (convError) throw convError;

      const { data: allParticipants } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id')
        .in('conversation_id', conversationIds)
        .neq('user_id', user.id);

      const otherUserIds = [...new Set(allParticipants?.map(p => p.user_id) || [])];
      
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', otherUserIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);
      // Add Zeus bot profile fallback
      if (!profileMap.has(ZEUS_BOT_ID) && otherUserIds.includes(ZEUS_BOT_ID)) {
        profileMap.set(ZEUS_BOT_ID, { user_id: ZEUS_BOT_ID, name: 'Zeus ⚡', avatar_url: null });
      }
      const participantMap = new Map(allParticipants?.map(p => [p.conversation_id, p.user_id]) || []);

      // Only fetch the LAST message per conversation + recent unread count
      // Instead of loading ALL messages, use a limited query per conversation
      const lastMessageMap = new Map<string, { body: string; created_at: string; sender_id: string }>();
      const unreadCounts: Record<string, number> = {};

      // Batch: get last message per conversation (limit to 1 per conv)
      // Use a single query with ordering - only fetch recent messages
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('conversation_id, body, created_at, sender_id')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false })
        .limit(conversationIds.length * 3); // ~3 per conv is enough for last msg + unread

      recentMessages?.forEach(m => {
        if (!lastMessageMap.has(m.conversation_id)) {
          lastMessageMap.set(m.conversation_id, m);
        }
      });

      // Count unread from the limited set (approximation, good enough for badge)
      recentMessages?.forEach(m => {
        const lastRead = lastReadMap.get(m.conversation_id);
        if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
          if (m.sender_id !== user.id) {
            unreadCounts[m.conversation_id] = (unreadCounts[m.conversation_id] || 0) + 1;
          }
        }
      });

      return conversations.map(conv => {
        const isGroup = (conv as any).is_group || false;
        const groupName = (conv as any).name || null;

        // Get all other participants for this conversation
        const convParticipants = (allParticipants || [])
          .filter(p => p.conversation_id === conv.id)
          .map(p => {
            const profile = profileMap.get(p.user_id);
            return {
              user_id: p.user_id,
              name: profile?.name || 'Unknown',
              avatar_url: profile?.avatar_url || null,
            };
          });

        // For 1:1 conversations, use the first (only) other participant
        const firstParticipant = convParticipants[0];

        return {
          id: conv.id,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          is_group: isGroup,
          name: groupName,
          created_by: (conv as any).created_by || null,
          participant: firstParticipant || {
            user_id: '',
            name: 'Unknown',
            avatar_url: null,
          },
          participants: isGroup ? convParticipants : undefined,
          last_message: lastMessageMap.get(conv.id),
          unread_count: unreadCounts[conv.id] || 0,
        } as Conversation;
      });
    },
    enabled: !!user,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
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
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
          queryClient.invalidateQueries({ queryKey: ['conversations'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, user, queryClient]);

  return useQuery({
    queryKey: ['messages', conversationId],
    queryFn: async () => {
      if (!conversationId || !user) return [];

      // Get hidden message IDs for this user
      const { data: deletions } = await supabase
        .from('message_deletions')
        .select('message_id')
        .eq('user_id', user.id);

      const hiddenIds = new Set((deletions || []).map(d => d.message_id));

      // Load only last 50 messages (cursor-based, most recent first then reversed)
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .in('status', ['delivered', 'pending'])
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      // Reverse to chronological order for display
      messages.reverse();

      if (error) throw error;

      // Filter out hidden messages
      const visibleMessages = messages.filter(m => !hiddenIds.has(m.id));

      const senderIds = [...new Set(visibleMessages.map(m => m.sender_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', senderIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      return visibleMessages.map(msg => ({
        ...msg,
        profile: {
          name: msg.sender_id === ZEUS_BOT_ID ? 'Zeus ⚡' : (profileMap.get(msg.sender_id)?.name || 'Unknown'),
          avatar_url: profileMap.get(msg.sender_id)?.avatar_url || null,
        },
      })) as Message[];
    },
    enabled: !!conversationId,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ conversationId, body, imageUrl }: { conversationId: string; body: string; imageUrl?: string }) => {
      if (!user) throw new Error('Not authenticated');

      // Check if this is a Zeus conversation
      const { data: zeusParticipant } = await supabase
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', ZEUS_BOT_ID)
        .maybeSingle();

      if (zeusParticipant) {
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

      const { data, error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          body: sanitizedBody,
          image_url: imageUrl || null,
        })
        .select()
        .single();

      if (error) throw error;

      // Record for rate limiting
      if (!isSpecialMessage) {
        recordSentMessage(sanitizedBody);
      }

      // AI moderation (async, non-blocking)
      if (!isSpecialMessage && data?.id) {
        supabase.functions.invoke('zeus', {
          body: { domain: 'moderation', action: 'moderate_message', messageBody: sanitizedBody, messageId: data.id },
        }).catch(() => {});
      }

      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      // Notification is now handled by the friendship trigger for non-friends
      // For friends, send notification as before
      if (data?.status === 'delivered') {
        const { data: participants } = await supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', conversationId)
          .neq('user_id', user.id);

        if (participants?.length) {
          await supabase.from('notifications').insert({
            user_id: participants[0].user_id,
            type: 'message',
            actor_id: user.id,
          });
        }
      }

      return data;
    },
    // Optimistic update: immediately show sent message in UI
    onMutate: async (variables) => {
      if (!user) return;

      await queryClient.cancelQueries({ queryKey: ['messages', variables.conversationId] });

      const previousMessages = queryClient.getQueryData<Message[]>(['messages', variables.conversationId]);

      const profile = queryClient.getQueryData<any>(['profile', user.id]);
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
        ['messages', variables.conversationId],
        (old) => [...(old || []), optimisticMessage]
      );

      return { previousMessages };
    },
    onError: (_err, variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(['messages', variables.conversationId], context.previousMessages);
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
    mutationFn: async ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('message_deletions')
        .insert({ message_id: messageId, user_id: user.id });

      if (error) throw error;
      return conversationId;
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

      const { data: existingParticipations } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', user.id);

      if (existingParticipations?.length) {
        const { data: otherParticipations } = await supabase
          .from('conversation_participants')
          .select('conversation_id')
          .eq('user_id', otherUserId)
          .in('conversation_id', existingParticipations.map(p => p.conversation_id));

        if (otherParticipations?.length) {
          return { id: otherParticipations[0].conversation_id };
        }
      }

      const conversationId = crypto.randomUUID();

      const { error: convError } = await supabase
        .from('conversations')
        .insert({ id: conversationId });

      if (convError) throw convError;

      // Insert self first so RLS allows adding the other user
      const { error: selfError } = await supabase
        .from('conversation_participants')
        .insert({ conversation_id: conversationId, user_id: user.id });

      if (selfError) {
        await supabase.from('conversations').delete().eq('id', conversationId);
        throw selfError;
      }

      const { error: otherError } = await supabase
        .from('conversation_participants')
        .insert({ conversation_id: conversationId, user_id: otherUserId });

      if (otherError) {
        await supabase.from('conversations').delete().eq('id', conversationId);
        throw otherError;
      }

      return { id: conversationId };
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

      const conversationId = crypto.randomUUID();

      const { error: convError } = await supabase
        .from('conversations')
        .insert({
          id: conversationId,
          name: name.trim(),
          is_group: true,
          created_by: user.id,
        });

      if (convError) throw convError;

      const participants = [user.id, ...memberIds].map(uid => ({
        conversation_id: conversationId,
        user_id: uid,
      }));

      const { error: partError } = await supabase
        .from('conversation_participants')
        .insert(participants);

      if (partError) {
        await supabase.from('conversations').delete().eq('id', conversationId);
        throw partError;
      }

      return { id: conversationId };
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
      const participants = memberIds.map(uid => ({
        conversation_id: conversationId,
        user_id: uid,
      }));
      const { error } = await supabase
        .from('conversation_participants')
        .insert(participants);
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
