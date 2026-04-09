import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

// Stripe IDs for ForSure Créateur
export const CREATOR_PLAN = {
  product_id: "prod_U6tyVVxTfK1n12",
  price_id: "price_1T8gAk6wgOEGAgcG4A12CIFZ",
} as const;

interface SubscriptionState {
  subscribed: boolean;
  productId: string | null;
  priceId: string | null;
  subscriptionEnd: string | null;
  loading: boolean;
}

export function useStripeSubscription() {
  const { user } = useAuth();
  const [state, setState] = useState<SubscriptionState>({
    subscribed: false,
    productId: null,
    priceId: null,
    subscriptionEnd: null,
    loading: true,
  });

  const checkSubscription = useCallback(async () => {
    if (!user) {
      setState(s => ({ ...s, subscribed: false, loading: false }));
      return;
    }

    try {
      // Check Stripe first
      const { data, error } = await supabase.functions.invoke('check-subscription');
      if (!error && data?.subscribed) {
        setState({
          subscribed: true,
          productId: data.product_id || null,
          priceId: data.price_id || null,
          subscriptionEnd: data.subscription_end || null,
          loading: false,
        });
        return;
      }

      // Fallback: check creator_subscriptions table in DB
      const { data: dbSub } = await supabase
        .from('creator_subscriptions')
        .select('status, plan, current_period_end')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

      if (dbSub) {
        setState({
          subscribed: true,
          productId: CREATOR_PLAN.product_id,
          priceId: CREATOR_PLAN.price_id,
          subscriptionEnd: dbSub.current_period_end || null,
          loading: false,
        });
        return;
      }

      setState({
        subscribed: false,
        productId: null,
        priceId: null,
        subscriptionEnd: null,
        loading: false,
      });
    } catch {
      setState(s => ({ ...s, loading: false }));
    }
  }, [user]);

  useEffect(() => {
    checkSubscription();
  }, [checkSubscription]);

  // Auto-refresh every 60s
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(checkSubscription, 60000);
    return () => clearInterval(interval);
  }, [user, checkSubscription]);

  const isCreatorSubscriber = state.subscribed && state.productId === CREATOR_PLAN.product_id;

  const startCheckout = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { priceId: CREATOR_PLAN.price_id },
      });
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err: any) {
      throw new Error(err.message || "Erreur lors de la création du paiement");
    }
  };

  const openPortal = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('customer-portal');
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err: any) {
      throw new Error(err.message || "Erreur lors de l'ouverture du portail");
    }
  };

  return {
    ...state,
    isCreatorSubscriber,
    checkSubscription,
    startCheckout,
    openPortal,
  };
}
