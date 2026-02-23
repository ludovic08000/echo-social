import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export function useProductFavorites() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['product-favorites', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('product_favorites')
        .select('product_id')
        .eq('user_id', user.id);
      if (error) throw error;
      return data.map((f) => f.product_id);
    },
    enabled: !!user,
  });
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (productId: string) => {
      if (!user) throw new Error('Non connecté');
      const { data: existing } = await supabase
        .from('product_favorites')
        .select('id')
        .eq('user_id', user.id)
        .eq('product_id', productId)
        .maybeSingle();

      if (existing) {
        await supabase.from('product_favorites').delete().eq('id', existing.id);
        return { added: false };
      } else {
        await supabase.from('product_favorites').insert({ user_id: user.id, product_id: productId });
        return { added: true };
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['product-favorites'] });
      toast.success(result.added ? 'Ajouté aux favoris ❤️' : 'Retiré des favoris');
    },
  });
}
