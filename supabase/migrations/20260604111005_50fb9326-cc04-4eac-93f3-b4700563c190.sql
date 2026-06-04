DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'message_device_copies'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_device_copies;
  END IF;
END $$;