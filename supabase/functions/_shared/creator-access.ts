import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Access is an operator grant or paid subscription, never browser metadata. */
export async function hasCreatorVoiceAccess(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data: grant, error: grantError } = await db.from('voice_command_grants').select('user_id')
    .eq('user_id', userId).is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).maybeSingle();
  if (grantError) throw new Error('VOICE_ACCESS_LOOKUP_FAILED');
  if (grant) return true;
  const { data, error } = await db.from('creator_subscriptions').select('user_id')
    .eq('user_id', userId).eq('status', 'active')
    .in('plan', ['creator_essential', 'creator_pro', 'creator_studio'])
    .not('stripe_subscription_id', 'is', null)
    .gt('current_period_end', new Date().toISOString()).maybeSingle();
  if (error) throw new Error('CREATOR_SUBSCRIPTION_LOOKUP_FAILED');
  return Boolean(data);
}
