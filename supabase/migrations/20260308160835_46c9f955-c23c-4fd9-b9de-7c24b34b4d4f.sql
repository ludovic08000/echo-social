ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS packing_video_url text,
  ADD COLUMN IF NOT EXISTS packing_video_status text NOT NULL DEFAULT 'none';