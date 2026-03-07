
-- Add sound preference columns to notification_settings
ALTER TABLE public.notification_settings 
  ADD COLUMN IF NOT EXISTS sound_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sound_type text NOT NULL DEFAULT 'default';
