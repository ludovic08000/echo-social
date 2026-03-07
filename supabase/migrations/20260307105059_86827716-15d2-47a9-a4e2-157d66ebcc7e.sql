
ALTER TABLE public.products 
  ADD COLUMN IF NOT EXISTS country text DEFAULT 'FR',
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS city text;
