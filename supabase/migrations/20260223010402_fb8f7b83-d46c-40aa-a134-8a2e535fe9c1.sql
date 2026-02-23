
-- Add extra product fields for size, color, and shipping
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS size text,
ADD COLUMN IF NOT EXISTS color text,
ADD COLUMN IF NOT EXISTS shipping_type text NOT NULL DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS shipping_price numeric DEFAULT 0;
