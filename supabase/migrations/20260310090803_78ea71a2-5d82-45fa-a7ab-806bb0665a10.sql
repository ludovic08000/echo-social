-- Clean up broken Zeus conversations (only 1 participant)
DELETE FROM conversations WHERE id IN (
  SELECT c.id FROM conversations c
  JOIN conversation_participants cp ON cp.conversation_id = c.id
  WHERE cp.user_id = '00000000-0000-0000-0000-000000000001'
  GROUP BY c.id
  HAVING COUNT(*) = 1
);