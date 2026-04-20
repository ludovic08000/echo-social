
-- ============================================================
-- PHASE B : Multi-device E2EE — schema only (no data migration)
-- ============================================================

-- 1) Registre des appareils par utilisateur
CREATE TABLE IF NOT EXISTS public.user_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  device_name text,
  device_public_key text NOT NULL,
  platform text,
  user_agent text,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_unique_per_user UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_active
  ON public.user_devices (user_id, is_active, last_seen_at DESC);

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

-- Un utilisateur ne voit / gère que ses propres appareils
CREATE POLICY "Users can view their own devices"
  ON public.user_devices FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can register their own devices"
  ON public.user_devices FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own devices"
  ON public.user_devices FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own devices"
  ON public.user_devices FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_user_devices_updated_at
  BEFORE UPDATE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- 2) Colonne body_kind sur messages (nullable, défaut 'legacy')
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS body_kind text NOT NULL DEFAULT 'legacy';

COMMENT ON COLUMN public.messages.body_kind IS
  'Type de body: legacy (single-device) | multi_device (fan-out via message_device_copies) | system';


-- 3) Copies chiffrées par appareil (fan-out)
CREATE TABLE IF NOT EXISTS public.message_device_copies (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  recipient_device_id text NOT NULL,
  sender_user_id uuid NOT NULL,
  sender_device_id text NOT NULL,
  encrypted_body text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  delivered_at timestamp with time zone,
  read_at timestamp with time zone,
  CONSTRAINT mdc_unique_copy UNIQUE (message_id, recipient_device_id)
);

CREATE INDEX IF NOT EXISTS idx_mdc_recipient_lookup
  ON public.message_device_copies (recipient_user_id, recipient_device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mdc_message
  ON public.message_device_copies (message_id);

ALTER TABLE public.message_device_copies ENABLE ROW LEVEL SECURITY;

-- Le destinataire authentifié peut lire SA copie
CREATE POLICY "Recipient can read own device copy"
  ON public.message_device_copies FOR SELECT
  USING (auth.uid() = recipient_user_id);

-- L'émetteur peut aussi lire ses propres copies envoyées (debug / multi-device sender)
CREATE POLICY "Sender can read copies they sent"
  ON public.message_device_copies FOR SELECT
  USING (auth.uid() = sender_user_id);

-- Seul l'émetteur authentifié peut insérer les copies qu'il envoie
CREATE POLICY "Sender can insert device copies"
  ON public.message_device_copies FOR INSERT
  WITH CHECK (auth.uid() = sender_user_id);

-- Seul le destinataire peut mettre à jour delivered_at / read_at
CREATE POLICY "Recipient can mark delivered/read"
  ON public.message_device_copies FOR UPDATE
  USING (auth.uid() = recipient_user_id)
  WITH CHECK (auth.uid() = recipient_user_id);


-- 4) RPC : liste des appareils actifs d'un utilisateur
--    (n'expose que device_id + clé publique, pas le user_agent)
CREATE OR REPLACE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE (
  device_id text,
  device_public_key text,
  last_seen_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.device_id, d.device_public_key, d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = p_user_id
    AND d.is_active = true
    AND d.last_seen_at > now() - interval '90 days'
  ORDER BY d.last_seen_at DESC;
$$;


-- 5) RPC : récupérer la copie chiffrée pour l'appareil courant
CREATE OR REPLACE FUNCTION public.get_device_copy_for_message(
  p_message_id uuid,
  p_device_id text
)
RETURNS TABLE (
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT mdc.encrypted_body, mdc.sender_user_id, mdc.sender_device_id, mdc.created_at
  FROM public.message_device_copies mdc
  WHERE mdc.message_id = p_message_id
    AND mdc.recipient_device_id = p_device_id
    AND mdc.recipient_user_id = auth.uid()
  LIMIT 1;
$$;
