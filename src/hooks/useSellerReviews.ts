import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export function useSellerReviews(sellerProfileId: string | undefined) {
  return useQuery({
    queryKey: ['seller-reviews', sellerProfileId],
    queryFn: async () => {
      if (!sellerProfileId) return [];
      const { data, error } = await supabase
        .from('seller_reviews')
        .select('*, profiles:user_id(name, avatar_url)')
        .eq('seller_id', sellerProfileId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!sellerProfileId,
  });
}

export function useCreateSellerReview() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      sellerProfileId,
      orderId,
      rating,
      body,
    }: {
      sellerProfileId: string;
      orderId: string;
      rating: number;
      body?: string;
    }) => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase
        .from('seller_reviews')
        .insert({
          seller_id: sellerProfileId,
          user_id: user.id,
          order_id: orderId,
          rating,
          body: body || null,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['seller-reviews', vars.sellerProfileId] });
      queryClient.invalidateQueries({ queryKey: ['my-orders'] });
      toast.success('Avis vendeur publié !');
    },
    onError: (e: any) => toast.error(e.message),
  });
}

export function useHasReviewedOrder(orderId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['seller-review-exists', orderId, user?.id],
    queryFn: async () => {
      if (!user || !orderId) return false;
      const { data } = await supabase
        .from('seller_reviews')
        .select('id')
        .eq('order_id', orderId)
        .eq('user_id', user.id)
        .maybeSingle();
      return !!data;
    },
    enabled: !!user && !!orderId,
  });
}
