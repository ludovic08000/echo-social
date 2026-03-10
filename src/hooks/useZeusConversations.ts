import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function useZeusConversations(agentId: string | null) {
  const { user } = useAuth();

  const conversationsQuery = useQuery({
    queryKey: ['zeus-conversations', user?.id, agentId],
    queryFn: async () => {
      if (!user || !agentId) return [];
      const { data } = await supabase
        .from('ai_agent_conversations')
        .select('id, title, updated_at')
        .eq('user_id', user.id)
        .eq('agent_id', agentId)
        .order('updated_at', { ascending: false })
        .limit(30);
      return data || [];
    },
    enabled: !!user && !!agentId,
  });

  return conversationsQuery;
}

export function useZeusMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ['zeus-messages', conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const { data } = await supabase
        .from('ai_agent_messages')
        .select('role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      return (data || []).map((m: any) => ({ role: m.role, content: m.content }));
    },
    enabled: !!conversationId,
  });
}
