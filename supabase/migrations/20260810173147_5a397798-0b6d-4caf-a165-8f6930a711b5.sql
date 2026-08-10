CREATE TABLE IF NOT EXISTS public.device_platform_metadata (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  device_model TEXT,
  runtime TEXT,
  secure_enclave_available BOOLEAN NOT NULL DEFAULT false,
  secure_storage_tier TEXT,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT device_platform_metadata_unique UNIQUE (user_id, device_id),
  CONSTRAINT device_platform_metadata_device_fkey
    FOREIGN KEY (user_id, device_id)
    REFERENCES public.user_devices (user_id, device_id) ON DELETE CASCADE,
  CONSTRAINT device_platform_metadata_platform_chk
    CHECK (platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_platform_metadata TO authenticated;
GRANT ALL ON public.device_platform_metadata TO service_role;

ALTER TABLE public.device_platform_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own device platform metadata"
ON public.device_platform_metadata
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_device_platform_metadata_updated_at
BEFORE UPDATE ON public.device_platform_metadata
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();