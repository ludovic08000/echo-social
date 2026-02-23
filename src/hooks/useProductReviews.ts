import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export function useProductReviews(productId: string | undefined) {
  return useQuery({
    queryKey: ['product-reviews', productId],
    queryFn: async () => {
      if (!productId) return [];
      const { data, error } = await supabase
        .from('product_reviews')
        .select('*, profiles:user_id(name, avatar_url)')
        .eq('product_id', productId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!productId,
  });
}

export function useCreateReview() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ productId, rating, title, body }: { productId: string; rating: number; title?: string; body?: string }) => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase
        .from('product_reviews')
        .insert({ user_id: user.id, product_id: productId, rating, title, body })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['product-reviews', vars.productId] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
      toast.success('Avis publié !');
    },
    onError: (e: any) => toast.error(e.message),
  });
}
