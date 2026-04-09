import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface AIAgent {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string;
  category: string;
  welcome_message: string | null;
  is_premium: boolean;
  free_messages_per_day: number;
  sort_order: number;
}

export interface AIAgentConversation {
  id: string;
  agent_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIAgentMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export function useAIAgentsList() {
  return useQuery({
    queryKey: ['ai-agents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ai_agents')
        .select('id, name, slug, description, icon, category, welcome_message, is_premium, free_messages_per_day, sort_order')
        .eq('is_active', true)
        .order('sort_order');
      if (error) throw error;
      return data as AIAgent[];
    },
  });
}

export function useAIAgentConversations(agentId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent-conversations', agentId],
    queryFn: async () => {
      if (!agentId) return [];
      const { data, error } = await supabase
        .from('ai_agent_conversations')
        .select('*')
        .eq('agent_id', agentId)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as AIAgentConversation[];
    },
    enabled: !!agentId,
  });
}

export function useAIAgentMessages(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent-messages', conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const { data, error } = await supabase
        .from('ai_agent_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at');
      if (error) throw error;
      return data as AIAgentMessage[];
    },
    enabled: !!conversationId,
  });
}

export function useAIAgentUsage(agentId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['ai-agent-usage', agentId, user?.id],
    queryFn: async () => {
      if (!agentId || !user) return null;
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('ai_agent_usage')
        .select('*')
        .eq('agent_id', agentId)
        .eq('user_id', user.id)
        .eq('usage_date', today)
        .maybeSingle();
      return data;
    },
    enabled: !!agentId && !!user,
  });
}
