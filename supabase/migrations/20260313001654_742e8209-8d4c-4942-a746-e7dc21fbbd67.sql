
-- Messaging performance indexes
CREATE INDEX IF NOT EXISTS idx_conv_participants_user_conv ON public.conversation_participants (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_conv_user ON public.conversation_participants (conversation_id, user_id);

-- Message deletions lookup
CREATE INDEX IF NOT EXISTS idx_message_deletions_user ON public.message_deletions (user_id, message_id);

-- Conversations ordering
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON public.conversations (updated_at DESC);

-- Friendships lookup for messaging checks
CREATE INDEX IF NOT EXISTS idx_friendships_status_users ON public.friendships (status, requester_id, addressee_id);
