-- Add group chat support to conversations
ALTER TABLE public.conversations 
ADD COLUMN IF NOT EXISTS name text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT NULL;