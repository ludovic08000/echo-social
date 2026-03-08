import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { useEffect } from 'react';

export interface Negotiation {
  id: string;
  product_id: string;
  buyer_id: string;
  seller_profile_id: string;
  conversation_id: string | null;
  original_price: number;
  offered_price: number;
  counter_price: number | null;
  status: string;
  order_id: string | null;
  created_at: string;
  updated_at: string;
}

export function useNegotiations(productId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['negotiations', productId, user?.id],
    queryFn: async () => {
      if (!user || !productId) return [];
      const { data, error } = await supabase
        .from('negotiations')
        .select('*')
        .eq('product_id', productId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as Negotiation[];
    },
    enabled: !!user && !!productId,
  });

  // Realtime subscription
  useEffect(() => {
    if (!productId) return;
    const channel = supabase
      .channel(`negotiations-${productId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'negotiations',
        filter: `product_id=eq.${productId}`,
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['negotiations', productId] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [productId, queryClient]);

  return query;
}

export function useNegotiationsByConversation(conversationId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['negotiations-by-conv', conversationId, user?.id],
    queryFn: async () => {
      if (!user || !conversationId) return [];
      const { data, error } = await supabase
        .from('negotiations')
        .select('*, products:product_id(id, title, price, thumbnail_url, seller_profiles:seller_profile_id(id, store_name, user_id, store_logo_url))')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
    enabled: !!user && !!conversationId,
  });

  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase
      .channel(`negotiations-conv-${conversationId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'negotiations',
        filter: `conversation_id=eq.${conversationId}`,
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['negotiations-by-conv', conversationId] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [conversationId, queryClient]);

  return query;
}

export function useCreateNegotiation() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      productId,
      sellerProfileId,
      originalPrice,
      offeredPrice,
      conversationId,
    }: {
      productId: string;
      sellerProfileId: string;
      originalPrice: number;
      offeredPrice: number;
      conversationId?: string;
    }) => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase
        .from('negotiations')
        .insert({
          product_id: productId,
          buyer_id: user.id,
          seller_profile_id: sellerProfileId,
          original_price: originalPrice,
          offered_price: offeredPrice,
          conversation_id: conversationId || null,
          status: 'pending',
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['negotiations', vars.productId] });
      toast.success('Offre envoyée !');
    },
    onError: (e: any) => toast.error(e.message),
  });
}

export function useRespondNegotiation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      negotiationId,
      action,
      counterPrice,
    }: {
      negotiationId: string;
      action: 'accepted' | 'rejected' | 'counter';
      counterPrice?: number;
    }) => {
      const update: Record<string, any> = { status: action, updated_at: new Date().toISOString() };
      if (action === 'counter' && counterPrice) {
        update.counter_price = counterPrice;
        update.status = 'counter';
      }
      const { data, error } = await supabase
        .from('negotiations')
        .update(update)
        .eq('id', negotiationId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['negotiations'] });
      if (data.status === 'accepted') toast.success('Offre acceptée !');
      else if (data.status === 'rejected') toast.info('Offre refusée');
      else if (data.status === 'counter') toast.info('Contre-offre envoyée');
    },
    onError: (e: any) => toast.error(e.message),
  });
}

export function useAcceptCounterOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ negotiationId }: { negotiationId: string }) => {
      const { data, error } = await supabase
        .from('negotiations')
        .update({
          status: 'accepted',
          offered_price: (await supabase.from('negotiations').select('counter_price').eq('id', negotiationId).single()).data?.counter_price,
          updated_at: new Date().toISOString(),
        })
        .eq('id', negotiationId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['negotiations'] });
      toast.success('Contre-offre acceptée !');
    },
    onError: (e: any) => toast.error(e.message),
  });
}
