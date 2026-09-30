import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export type DirectMessageInboxCategory =
  | 'primary'
  | 'requests'
  | 'spam'
  | 'hidden'
  | 'outgoing_pending'
  | 'draft_request';

export type DirectMessageRequestRole = 'sender' | 'recipient' | 'none';
export type DirectMessageRequestStatus =
  | 'draft'
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'spam'
  | 'blocked';

export interface DirectMessageRequestState {
  conversation_id: string;
  inbox_category: DirectMessageInboxCategory;
  request_role: DirectMessageRequestRole;
  request_status: DirectMessageRequestStatus;
  can_send_text: boolean;
  can_send_media: boolean;
  can_call: boolean;
}

export type DirectMessageRequestAction = 'accept' | 'dismiss' | 'report_spam' | 'block';

function isInboxCategory(value: unknown): value is DirectMessageInboxCategory {
  return [
    'primary',
    'requests',
    'spam',
    'hidden',
    'outgoing_pending',
    'draft_request',
  ].includes(String(value));
}

function isRequestRole(value: unknown): value is DirectMessageRequestRole {
  return ['sender', 'recipient', 'none'].includes(String(value));
}

function isRequestStatus(value: unknown): value is DirectMessageRequestStatus {
  return ['draft', 'pending', 'accepted', 'dismissed', 'spam', 'blocked'].includes(String(value));
}

export async function loadDirectMessageRequestStates(): Promise<Map<string, DirectMessageRequestState>> {
  const states = new Map<string, DirectMessageRequestState>();
  const { data, error } = await supabase.rpc('get_direct_message_request_states' as never);
  if (error) {
    // Safe staged rollout: an older backend keeps the established inbox until
    // the migration is present instead of making messaging disappear.
    console.warn('[messaging] request-state RPC unavailable; using primary inbox fallback', {
      code: error.code ?? 'RPC_UNAVAILABLE',
    });
    return states;
  }

  for (const raw of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    if (
      typeof raw.conversation_id !== 'string' ||
      !isInboxCategory(raw.inbox_category) ||
      !isRequestRole(raw.request_role) ||
      !isRequestStatus(raw.request_status)
    ) {
      continue;
    }
    states.set(raw.conversation_id, {
      conversation_id: raw.conversation_id,
      inbox_category: raw.inbox_category,
      request_role: raw.request_role,
      request_status: raw.request_status,
      can_send_text: raw.can_send_text === true,
      can_send_media: raw.can_send_media === true,
      can_call: raw.can_call === true,
    });
  }
  return states;
}

export function useDirectMessageRequestAction(conversationId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (action: DirectMessageRequestAction) => {
      if (!user?.id) throw new Error('NOT_AUTHENTICATED');
      const { data, error } = await supabase.rpc(
        'aegis_set_direct_message_request' as never,
        {
          p_conversation_id: conversationId,
          p_action: action,
        } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations', user?.id ?? 'anon'] }),
        queryClient.invalidateQueries({ queryKey: ['messages', conversationId] }),
      ]);
    },
  });
}
