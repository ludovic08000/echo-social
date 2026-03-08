
CREATE POLICY "Sellers can view orders containing their items"
ON public.orders
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM order_items oi
    JOIN seller_profiles sp ON sp.id = oi.seller_id
    WHERE oi.order_id = orders.id
    AND sp.user_id = auth.uid()
  )
);
