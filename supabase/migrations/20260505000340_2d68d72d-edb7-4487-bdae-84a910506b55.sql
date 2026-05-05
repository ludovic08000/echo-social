ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'notification_type'
      AND e.enumlabel = 'new_device'
  ) THEN
    ALTER TYPE public.notification_type ADD VALUE 'new_device';
  END IF;
END $$;