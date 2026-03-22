import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export interface LocationFilter {
  country?: string;
  region?: string;
  city?: string;
  scope?: 'local' | 'region' | 'country' | 'europe';
}

export function useProducts(category?: string, search?: string, location?: LocationFilter, limit?: number) {
  return useQuery({
    queryKey: ['products', category, search, location, limit],
    queryFn: async () => {
      let query = supabase
        .from('products')
        .select('*, seller_profiles(store_name, store_logo_url, is_verified)')
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (category && category !== 'all') {
        query = query.eq('category', category);
      }
      if (search) {
        query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
      }
      
      // Location filters
      if (location?.scope !== 'europe') {
        if (location?.country) {
          query = query.eq('country', location.country);
        }
        if (location?.region) {
          query = query.eq('region', location.region);
        }
        if (location?.city) {
          query = query.eq('city', location.city);
        }
      }

      // Apply limit if specified (for feed widgets)
      if (limit) {
        query = query.limit(limit);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: ['product', id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from('products')
        .select('*, seller_profiles(id, user_id, store_name, store_logo_url, is_verified, store_description, rating_average, rating_count, total_sales)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });
}

export function useSellerProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['seller-profile', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await supabase
        .from('seller_profiles')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function useSellerProducts() {
  const { user } = useAuth();
  const { data: seller } = useSellerProfile();
  return useQuery({
    queryKey: ['seller-products', seller?.id],
    queryFn: async () => {
      if (!seller) return [];
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('seller_id', seller.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!seller,
  });
}

export function useCreateSellerProfile() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (storeName: string) => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase
        .from('seller_profiles')
        .insert({ user_id: user.id, store_name: storeName })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-profile'] });
      toast.success('Boutique créée avec succès !');
    },
    onError: (e: any) => toast.error(e.message),
  });
}

export function useCreateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (product: {
      seller_id: string;
      title: string;
      description?: string;
      price: number;
      category: string;
      product_type: 'physical';
      images?: string[];
      thumbnail_url?: string;
      stock_quantity?: number;
      size?: string;
      color?: string;
      condition?: string;
      shipping_type?: string;
      shipping_price?: number;
      weight_grams?: number;
      country?: string;
      region?: string;
      city?: string;
    }) => {
      const { data, error } = await supabase
        .from('products')
        .insert(product)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Produit ajouté !');
    },
    onError: (e: any) => toast.error(e.message),
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (productId: string) => {
      const { error } = await supabase.from('products').delete().eq('id', productId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      // silent delete
    },
    onError: (e: any) => toast.error(e.message),
  });
}

export function useCart() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['cart', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('cart_items')
        .select('*, products(id, title, price, thumbnail_url, images, stock_quantity, seller_id, product_type, weight_grams, seller_profiles(store_name))')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function useAddToCart() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ productId, quantity = 1 }: { productId: string; quantity?: number }) => {
      if (!user) throw new Error('Non connecté');

      // Prevent seller from buying their own product
      const { data: product } = await supabase
        .from('products')
        .select('seller_id, seller_profiles(user_id)')
        .eq('id', productId)
        .single();
      if (product?.seller_profiles && (product.seller_profiles as any).user_id === user.id) {
        throw new Error('Vous ne pouvez pas acheter votre propre produit');
      }

      // Check stock availability
      const { data: stockCheck } = await supabase
        .from('products')
        .select('stock_quantity')
        .eq('id', productId)
        .single();

      const maxAllowedQty = stockCheck?.stock_quantity ?? 1;

      if (maxAllowedQty <= 0) {
        throw new Error('Ce produit est épuisé');
      }

      // Check if already in cart
      const { data: existing } = await supabase
        .from('cart_items')
        .select('id, quantity')
        .eq('user_id', user.id)
        .eq('product_id', productId)
        .maybeSingle();

      if (existing) {
        const newQty = existing.quantity + quantity;
        if (newQty > maxAllowedQty) {
          throw new Error(maxAllowedQty === 1
            ? 'Ce produit est déjà dans votre panier'
            : `Stock insuffisant (${maxAllowedQty} disponible${maxAllowedQty > 1 ? 's' : ''})`);
        }

        const { error } = await supabase
          .from('cart_items')
          .update({ quantity: newQty })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const safeQty = Math.min(quantity, maxAllowedQty);
        const { error } = await supabase
          .from('cart_items')
          .insert({ user_id: user.id, product_id: productId, quantity: safeQty });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
      toast.success('Ajouté au panier !');
    },
    onError: (e: any) => {
      // Refetch product data to show updated stock
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
      toast.error(e.message);
    },
  });
}

export function useUpdateCartItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, quantity }: { id: string; quantity: number }) => {
      if (quantity <= 0) {
        const { error } = await supabase.from('cart_items').delete().eq('id', id);
        if (error) throw error;
      } else {
        // Verify stock before updating
        const { data: cartItem } = await supabase
          .from('cart_items')
          .select('product_id')
          .eq('id', id)
          .maybeSingle();
        if (cartItem) {
          const { data: product } = await supabase
            .from('products')
            .select('stock_quantity, is_active')
            .eq('id', cartItem.product_id)
            .maybeSingle();
          if (product && !product.is_active) throw new Error('Ce produit n\'est plus disponible');
          const maxAllowedQty = product?.stock_quantity ?? 1;
          if (quantity > maxAllowedQty) {
            throw new Error(maxAllowedQty === 1 ? 'Ce produit est limité à 1 exemplaire' : `Stock max : ${maxAllowedQty}`);
          }
        }
        const { error } = await supabase.from('cart_items').update({ quantity }).eq('id', id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
    },
    onError: (e: any) => {
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
      toast.error(e.message);
    },
  });
}

export function useRemoveFromCart() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('cart_items').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      toast.success('Retiré du panier');
    },
  });
}

export function useMyOrders() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-orders', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*, products(title, thumbnail_url))')
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}
