ALTER TABLE public.user_backups 
ADD COLUMN IF NOT EXISTS wrapped_master_key TEXT,
ADD COLUMN IF NOT EXISTS master_key_iv TEXT;