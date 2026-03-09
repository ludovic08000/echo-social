import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export const ALLOWED_MINOR_CATEGORIES = ['education', 'sport', 'gaming', 'musique', 'art', 'humour'] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  education: '📚 Éducatif',
  sport: '⚽ Sport',
  gaming: '🎮 Gaming',
  musique: '🎵 Musique',
  art: '🎨 Art',
  humour: '😂 Humour',
};

export function useParentalControl() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['parental-control', user?.id],
    queryFn: async () => {
      if (!user) return null;
      // Only fetch non-sensitive fields — pin_hash is excluded by RLS
      const { data, error } = await supabase
        .from('parental_controls')
        .select('id, user_id, is_active, is_minor, allowed_categories, created_at, updated_at')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
}

export function useSetParentalPin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ pin, allowedCategories }: { pin: string; allowedCategories?: string[] }) => {
      // PIN is sent to the server — hashing happens server-side only
      const { data, error } = await supabase.functions.invoke('verify-parental-pin', {
        body: {
          action: 'set',
          pin,
          allowed_categories: allowedCategories || ALLOWED_MINOR_CATEGORIES as unknown as string[],
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parental-control'] });
    },
  });
}

export function useVerifyParentalPin() {
  return useMutation({
    mutationFn: async (pin: string): Promise<boolean> => {
      // PIN is verified server-side — no hash exposed to client
      let { data, error } = await supabase.functions.invoke('verify-parental-pin', {
        body: { action: 'verify', pin },
      });

      // Retry on auth error
      if (error && (error.message?.includes('401') || error.message?.includes('auth'))) {
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (!refreshErr) {
          const retry = await supabase.functions.invoke('verify-parental-pin', {
            body: { action: 'verify', pin },
          });
          data = retry.data;
          error = retry.error;
        }
      }

      if (error) throw error;
      return !!data?.ok;
    },
  });
}

export function useIsMinorWithParentalControl() {
  const { data: parentalControl, isLoading } = useParentalControl();

  return {
    isMinor: !!parentalControl?.is_active,
    allowedCategories: (parentalControl as any)?.allowed_categories || [],
    isLoading,
  };
}
