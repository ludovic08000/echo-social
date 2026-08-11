CREATE TABLE public.device_encrypted_vaults (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios-web',
  vault JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT device_encrypted_vaults_unique UNIQUE (user_id, device_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_encrypted_vaults TO authenticated;
GRANT ALL ON public.device_encrypted_vaults TO service_role;

ALTER TABLE public.device_encrypted_vaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own device vaults"
ON public.device_encrypted_vaults
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_device_encrypted_vaults_user ON public.device_encrypted_vaults (user_id);

CREATE TRIGGER update_device_encrypted_vaults_updated_at
BEFORE UPDATE ON public.device_encrypted_vaults
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();