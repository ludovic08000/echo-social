
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_method TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS shipping_relay_id TEXT,
  ADD COLUMN IF NOT EXISTS shipping_relay_name TEXT,
  ADD COLUMN IF NOT EXISTS shipping_relay_address TEXT,
  ADD COLUMN IF NOT EXISTS shipping_relay_postcode TEXT,
  ADD COLUMN IF NOT EXISTS shipping_relay_city TEXT,
  ADD COLUMN IF NOT EXISTS shipping_relay_country TEXT DEFAULT 'FR',
  ADD COLUMN IF NOT EXISTS tracking_number TEXT,
  ADD COLUMN IF NOT EXISTS shipping_label_url TEXT,
  ADD COLUMN IF NOT EXISTS shipping_weight_grams INTEGER DEFAULT 500;
