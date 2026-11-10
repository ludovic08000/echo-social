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
  const { user } = useAuth();
  return useQuery({
    queryKey: ['zeus-messages', user?.id, conversationId],
    queryFn: async () => {
      if (!user || !conversationId) return [];
      const { data } = await supabase
        .from('ai_agent_messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      return (data || []).map(m => ({ id:m.id,role: m.role, content: m.content }));
    },
    enabled: !!user && !!conversationId,
  });
}
