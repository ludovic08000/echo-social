
-- Table for identity verification requests
CREATE TABLE public.identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_user_id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  reason text DEFAULT 'fake_account',
  status text NOT NULL DEFAULT 'pending_verification',
  id_document_url text,
  verified_at timestamp with time zone,
  deadline_at timestamp with time zone NOT NULL DEFAULT (now() + interval '72 hours'),
  auto_deleted boolean NOT NULL DEFAULT false,
  admin_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.identity_verifications ENABLE ROW LEVEL SECURITY;

-- Users can see their own verification requests (as reported user)
CREATE POLICY "Users can view own verification" ON public.identity_verifications
  FOR SELECT TO authenticated
  USING (reported_user_id = auth.uid());

-- Users can upload their ID document
CREATE POLICY "Users can update own verification" ON public.identity_verifications
  FOR UPDATE TO authenticated
  USING (reported_user_id = auth.uid())
  WITH CHECK (reported_user_id = auth.uid());

-- Authenticated users can report fake accounts
CREATE POLICY "Users can report fake accounts" ON public.identity_verifications
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

-- Admins can manage all verifications
CREATE POLICY "Admins can manage verifications" ON public.identity_verifications
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Storage bucket for ID documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('id-documents', 'id-documents', false)
ON CONFLICT (id) DO NOTHING;

-- Only the reported user can upload their ID
CREATE POLICY "Users upload own ID" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'id-documents' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can view their own uploads
CREATE POLICY "Users view own ID docs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'id-documents' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Admins can view all ID docs
CREATE POLICY "Admins view all ID docs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'id-documents' AND
    public.has_role(auth.uid(), 'admin')
  );
