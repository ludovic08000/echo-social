DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'sender_key_distribution'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.sender_key_distribution';
  END IF;
END $$;

ALTER TABLE public.sender_key_distribution REPLICA IDENTITY FULL;