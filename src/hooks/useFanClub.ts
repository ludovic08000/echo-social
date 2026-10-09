import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export const FAN_CLUB_PRICES = [
  { cents: 199, label: '1,99 €' },
  { cents: 299, label: '2,99 €' },
  { cents: 499, label: '4,99 €' },
  { cents: 999, label: '9,99 €' },
  { cents: 1999, label: '19,99 €' },
] as const;

export function formatFanClubPrice(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €/mois`;
}

// Commission ForSure de 25 % sur les abonnements des fans : le créateur garde 75 %.
export const FAN_CLUB_COMMISSION_RATE = 0.25;

export function splitFanClubPayment(amountCents: number): {
  commissionCents: number;
  creatorPayoutCents: number;
} {
  const commissionCents = Math.round(amountCents * FAN_CLUB_COMMISSION_RATE);
  return { commissionCents, creatorPayoutCents: amountCents - commissionCents };
}

// Les fonctions Edge renvoient un message français dans le corps de la réponse :
// on le lit ici pour que l'utilisateur voie la vraie raison du refus.
async function readFunctionError(error: unknown): Promise<string> {
  const anyError = error as { context?: { json?: () => Promise<{ error?: string }> }; message?: string };
  const context = anyError?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error) return body.error;
    } catch {
      // corps illisible : on retombe sur le message générique
    }
  }
  return anyError?.message || 'Erreur inattendue';
}

export function useFanClub(creatorId?: string) {
  return useQuery({
    queryKey: ['fan-club', creatorId],
    queryFn: async () => {
      if (!creatorId) return null;
      const { data, error } = await supabase
        .from('fan_clubs')
        .select('creator_id, is_enabled, monthly_price_cents, description')
        .eq('creator_id', creatorId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!creatorId,
    staleTime: 60_000,
  });
}

// Ma relation d'abonnement avec un créateur précis (côté fan).
export function useMyFanSubscription(creatorId?: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['fan-subscription', user?.id, creatorId],
    queryFn: async () => {
      if (!user || !creatorId) return null;
      const { data, error } = await supabase
        .from('fan_subscriptions')
        .select('status, amount_cents, current_period_end')
        .eq('creator_id', creatorId)
        .eq('fan_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user && !!creatorId,
    staleTime: 30_000,
  });
}

// Les clubs que je paie (côté fan).
export function useMyFanSubscriptions() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-fan-subscriptions', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('fan_subscriptions')
        .select('creator_id, status, amount_cents, current_period_end, created_at')
        .eq('fan_id', user.id)
        .in('status', ['active', 'pending', 'past_due'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
  });
}

// Mes abonnés actifs (côté créateur).
export function useFanClubMembers(creatorId?: string) {
  const { user } = useAuth();
  const isOwner = !!user && !!creatorId && user.id === creatorId;

  return useQuery({
    queryKey: ['fan-club-members', creatorId],
    queryFn: async () => {
      if (!creatorId) return [];
      const { data, error } = await supabase
        .from('fan_subscriptions')
        .select('fan_id, status, amount_cents, current_period_end, created_at')
        .eq('creator_id', creatorId)
        .in('status', ['active', 'pending', 'past_due'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: isOwner,
  });
}

export function useUpdateFanClub() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { is_enabled: boolean; monthly_price_cents?: number; description?: string }) => {
      const { data, error } = await supabase.functions.invoke('fan-club-manage', { body: input });
      if (error) throw new Error(await readFunctionError(error));
      if (data?.error) throw new Error(data.error);
      return data as { is_enabled: boolean; monthly_price_cents: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fan-club'] });
    },
  });
}

export function useSubscribeToCreator() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (creatorId: string) => {
      const { data, error } = await supabase.functions.invoke('create-fan-subscription', {
        body: { creator_id: creatorId },
      });
      if (error) throw new Error(await readFunctionError(error));
      if (data?.error) throw new Error(data.error);
      if (!data?.url) throw new Error('Le paiement n\'est pas disponible pour le moment.');
      window.open(data.url, '_blank');
      return data as { url: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fan-subscription'] });
    },
  });
}
