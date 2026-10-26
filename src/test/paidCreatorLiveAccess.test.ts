import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261026223607_restrict_live_creation_to_paid_creators.sql',
  'utf8',
);
const tokenFunction = readFileSync('supabase/functions/livekit-token/index.ts', 'utf8');
const liveScreen = readFileSync('src/pages/LiveScreen.tsx', 'utf8');
const legacyLives = readFileSync('src/pages/Lives.tsx', 'utf8');
const createPost = readFileSync('src/components/CreatePost.tsx', 'utf8');
const landing = readFileSync('src/pages/Landing.tsx', 'utf8');

describe('paid creator live access architecture', () => {
  it('uses Stripe-backed, active and unexpired server state for live creation', () => {
    expect(migration).toContain('subscription.status = \'active\'');
    expect(migration).toContain("subscription.plan = 'creator_monthly'");
    expect(migration).toContain('subscription.stripe_subscription_id is not null');
    expect(migration).toContain('subscription.current_period_end > now()');
    expect(migration).toContain('(select auth.uid()) = user_id');
  });

  it('prevents the browser from manufacturing a paid creator subscription', () => {
    expect(migration).toContain('drop policy if exists "Users can insert their own subscription"');
    expect(migration).toContain('drop policy if exists "Users can update their own subscription"');
    expect(migration).toContain('revoke insert, update, delete on public.creator_subscriptions from anon, authenticated');
  });

  it('rechecks subscription before issuing a host publishing token', () => {
    expect(tokenFunction).toContain('diagnostic.step("creator_subscription")');
    expect(tokenFunction).toContain('.eq("status", "active")');
    expect(tokenFunction).toContain('.eq("plan", "creator_monthly")');
    expect(tokenFunction).toContain('.not("stripe_subscription_id", "is", null)');
    expect(tokenFunction).toContain('.gt("current_period_end", new Date().toISOString())');
    expect(tokenFunction).toContain('LIVE_CREATOR_SUBSCRIPTION_REQUIRED');
  });

  it('gates every current live or replay entry point in the interface', () => {
    expect(liveScreen).toContain('isCreatorSubscriber');
    expect(liveScreen).toContain('requestStartLive');
    expect(legacyLives).toContain('isCreatorSubscriber');
    expect(legacyLives).toContain('requestStartLive');
    expect(createPost).toContain('publishAsReplay && isCreatorSubscriber');
    expect(landing).not.toContain('Live streaming gratuit');
    expect(landing).toContain('abonnement actif');
  });
});
