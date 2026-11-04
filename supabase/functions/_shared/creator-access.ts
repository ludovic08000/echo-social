import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Paid entitlement comes from server-owned subscription records. */
export async function hasCreatorVoiceAccess(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db.from('creator_subscriptions').select('user_id')
    .eq('user_id', userId).eq('status', 'active')
    .in('plan', ['creator_essential', 'creator_pro', 'creator_studio'])
    .not('stripe_subscription_id', 'is', null)
    .gt('current_period_end', new Date().toISOString()).maybeSingle();
  if (error) throw new Error('CREATOR_SUBSCRIPTION_LOOKUP_FAILED');
  return Boolean(data);
}
