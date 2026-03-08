-- Create a private bucket for background images
INSERT INTO storage.buckets (id, name, public)
VALUES ('backgrounds', 'backgrounds', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload their own backgrounds
CREATE POLICY "Users can upload their own backgrounds"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'backgrounds'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- Allow users to read their own backgrounds (needed for signed URLs)
CREATE POLICY "Users can read their own backgrounds"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'backgrounds'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- Allow users to update their own backgrounds
CREATE POLICY "Users can update their own backgrounds"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'backgrounds'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- Allow users to delete their own backgrounds
CREATE POLICY "Users can delete their own backgrounds"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'backgrounds'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);