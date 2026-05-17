ALTER TABLE public.device_signed_prekeys REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_signed_prekeys;