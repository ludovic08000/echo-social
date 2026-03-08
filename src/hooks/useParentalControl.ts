import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

// Simple hash for PIN (not crypto-grade but sufficient for parental PIN)
async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + 'forsure-parental-salt');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
      const { data, error } = await supabase
        .from('parental_controls')
        .select('*')
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
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ pin, allowedCategories }: { pin: string; allowedCategories?: string[] }) => {
      if (!user) throw new Error('Not authenticated');
      const pinHash = await hashPin(pin);

      // Check if already exists
      const { data: existing } = await supabase
        .from('parental_controls')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from('parental_controls')
          .update({
            pin_hash: pinHash,
            allowed_categories: allowedCategories || ALLOWED_MINOR_CATEGORIES as unknown as string[],
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('parental_controls')
          .insert({
            user_id: user.id,
            pin_hash: pinHash,
            allowed_categories: allowedCategories || ALLOWED_MINOR_CATEGORIES as unknown as string[],
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parental-control'] });
    },
  });
}

export function useVerifyParentalPin() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (pin: string) => {
      if (!user) throw new Error('Not authenticated');
      const pinHash = await hashPin(pin);

      const { data, error } = await supabase
        .from('parental_controls')
        .select('pin_hash')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('No parental control found');

      return data.pin_hash === pinHash;
    },
  });
}

export function useIsMinorWithParentalControl() {
  const { data: parentalControl, isLoading } = useParentalControl();

  return {
    isMinor: !!parentalControl?.is_active,
    allowedCategories: parentalControl?.allowed_categories || [],
    isLoading,
  };
}
