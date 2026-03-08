import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSellerProfile } from '@/hooks/useMarketplace';

export function useSellerOrders() {
  const { data: seller } = useSellerProfile();

  return useQuery({
    queryKey: ['seller-orders', seller?.id],
    queryFn: async () => {
      if (!seller) return [];
      // Get orders that contain items from this seller
      const { data: orderItems, error } = await supabase
        .from('order_items')
        .select('order_id')
        .eq('seller_id', seller.id);

      if (error) throw error;
      if (!orderItems?.length) return [];

      const orderIds = [...new Set(orderItems.map((i) => i.order_id))];

      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('*, order_items(id, title, quantity, price, subtotal, status)')
        .in('id', orderIds)
        .order('created_at', { ascending: false });

      if (ordersError) throw ordersError;
      return orders || [];
    },
    enabled: !!seller,
  });
}
