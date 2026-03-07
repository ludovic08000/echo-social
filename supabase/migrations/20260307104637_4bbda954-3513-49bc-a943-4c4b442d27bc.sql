
-- Archive table for identity theft cases with full evidence for legal complaints
CREATE TABLE public.identity_theft_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The usurper
  usurper_user_id uuid NOT NULL,
  usurper_name text,
  usurper_email text,
  usurper_avatar_url text,
  usurper_bio text,
  -- The victim who reported
  victim_user_id uuid,
  victim_name text,
  -- Evidence
  ip_addresses text[] NOT NULL DEFAULT '{}',
  device_fingerprints jsonb NOT NULL DEFAULT '[]',
  connection_logs jsonb NOT NULL DEFAULT '[]',
  screenshots_urls text[] NOT NULL DEFAULT '{}',
  profile_snapshot jsonb,
  -- Admin
  archived_by uuid NOT NULL,
  archived_at timestamp with time zone NOT NULL DEFAULT now(),
  admin_notes text,
  case_number text NOT NULL,
  status text NOT NULL DEFAULT 'archived',
  -- Legal
  legal_complaint_filed boolean NOT NULL DEFAULT false,
  legal_complaint_date timestamp with time zone,
  legal_reference text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.identity_theft_archives ENABLE ROW LEVEL SECURITY;

-- Only admins can manage archives
CREATE POLICY "Admins can manage archives" ON public.identity_theft_archives
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Victims can view their own cases
CREATE POLICY "Victims can view their cases" ON public.identity_theft_archives
  FOR SELECT TO authenticated
  USING (victim_user_id = auth.uid());
