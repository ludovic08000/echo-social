-- Delete all AI agent messages for this user
DELETE FROM ai_agent_messages 
WHERE conversation_id IN (
  SELECT id FROM ai_agent_conversations 
  WHERE user_id = '98c32ea4-faae-4c87-b8d4-8a0ea9e7be7e'
);

-- Delete all AI agent conversations for this user
DELETE FROM ai_agent_conversations 
WHERE user_id = '98c32ea4-faae-4c87-b8d4-8a0ea9e7be7e';

-- Reset usage counter
DELETE FROM ai_agent_usage 
WHERE user_id = '98c32ea4-faae-4c87-b8d4-8a0ea9e7be7e';