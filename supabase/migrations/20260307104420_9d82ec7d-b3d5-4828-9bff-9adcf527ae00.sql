
-- Table for banned emails
CREATE TABLE public.banned_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  reason text,
  banned_by uuid NOT NULL,
  banned_at timestamp with time zone NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  associated_user_id uuid,
  UNIQUE(email)
);

ALTER TABLE public.banned_emails ENABLE ROW LEVEL SECURITY;

-- Only admins can manage banned emails
CREATE POLICY "Admins can manage banned emails" ON public.banned_emails
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Add columns to identity_verifications for IP/email tracking
ALTER TABLE public.identity_verifications 
  ADD COLUMN IF NOT EXISTS reported_ip text,
  ADD COLUMN IF NOT EXISTS reported_email text,
  ADD COLUMN IF NOT EXISTS auto_ban_ip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_ban_email boolean NOT NULL DEFAULT false;
