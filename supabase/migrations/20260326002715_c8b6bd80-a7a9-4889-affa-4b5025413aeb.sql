ALTER TABLE public.user_chat_pins 
  ADD COLUMN IF NOT EXISTS reset_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS reset_code_salt TEXT,
  ADD COLUMN IF NOT EXISTS reset_code_expires TIMESTAMPTZ;