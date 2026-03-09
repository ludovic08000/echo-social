-- Allow product_id to be nullable in order_items (order history must survive product deletion)
ALTER TABLE public.order_items ALTER COLUMN product_id DROP NOT NULL;

-- Drop the old FK and recreate with ON DELETE SET NULL
ALTER TABLE public.order_items DROP CONSTRAINT order_items_product_id_fkey;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_product_id_fkey 
  FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;