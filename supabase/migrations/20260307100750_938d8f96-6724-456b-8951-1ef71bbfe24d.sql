
-- AI Agents table (pre-configured by ForSure)
CREATE TABLE public.ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  icon text NOT NULL DEFAULT '🤖',
  category text NOT NULL DEFAULT 'general',
  system_prompt text NOT NULL,
  welcome_message text,
  is_premium boolean NOT NULL DEFAULT false,
  free_messages_per_day integer NOT NULL DEFAULT 5,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "AI agents are viewable by everyone"
  ON public.ai_agents FOR SELECT
  USING (is_active = true);

-- AI Agent conversations
CREATE TABLE public.ai_agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_agent_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their agent conversations"
  ON public.ai_agent_conversations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- AI Agent messages
CREATE TABLE public.ai_agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.ai_agent_conversations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_agent_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their agent messages"
  ON public.ai_agent_messages FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.ai_agent_conversations
    WHERE id = ai_agent_messages.conversation_id
    AND user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.ai_agent_conversations
    WHERE id = ai_agent_messages.conversation_id
    AND user_id = auth.uid()
  ));

-- Daily usage tracking for freemium
CREATE TABLE public.ai_agent_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  message_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, agent_id, usage_date)
);

ALTER TABLE public.ai_agent_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their usage"
  ON public.ai_agent_usage FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
