import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('creator-only ads and AI agents architecture', () => {
  it('guards creator routes and hides creator-only navigation entries', () => {
    const app = readSource('src/App.tsx');
    const sidebar = readSource('src/components/feed/FeedLeftSidebar.tsx');
    const mobileNavigation = readSource('src/components/Navigation.tsx');

    expect(app).toContain('path="/ads" element={<CreatorOnlyRoute>');
    expect(app).toContain('path="/ai-agents" element={<CreatorOnlyRoute>');
    expect(sidebar).toContain("item.path !== '/ads' && item.path !== '/ai-agents'");
    expect(mobileNavigation).toContain("profile?.is_creator || item.path !== '/ads'");
  });

  it('enforces creator access in database policies and cloud functions', () => {
    const migration = readSource('supabase/migrations/20260930120400_restrict_creator_ads_and_agents.sql');
    const zeus = readSource('supabase/functions/zeus/index.ts');
    const checkout = readSource('supabase/functions/ad-checkout/index.ts');
    const stripeWebhook = readSource('supabase/functions/stripe-webhook/index.ts');

    expect(migration).toContain('security definer');
    expect(migration).toContain('profile.is_creator is true');
    expect(migration).toContain('Creator advertisers manage own ads');
    expect(migration).toContain('Creators manage their agent conversations');
    expect(migration).toContain('AD_PAYMENT_STATE_SERVER_ONLY');
    expect(migration).toContain("and paid_at is not null");
    expect(zeus).toContain('CREATOR_ONLY_DOMAINS = new Set(["ads", "agent"])');
    expect(zeus).toContain('CREATOR_ACCOUNT_REQUIRED');
    expect(checkout).toContain('.eq("advertiser_id", user.id)');
    expect(checkout).toContain('const numAmount = Number(campaign.budget)');
    expect(checkout).toContain('idempotencyKey: `forsure-ad-campaign-${campaign_id}`');
    expect(stripeWebhook).toContain('metadataType === "ad_campaign"');
    expect(stripeWebhook).toContain('session.payment_status !== "paid"');
    expect(stripeWebhook).toContain('session.currency !== "eur"');
    expect(stripeWebhook).toContain('paid_at: startsAt.toISOString()');
  });

  it('only exposes confirmed deletion for owned old ads and campaigns', () => {
    const manager = readSource('src/pages/AdsManager.tsx');
    const campaignHooks = readSource('src/hooks/useAdCampaigns.ts');
    const adHooks = readSource('src/hooks/useAdsMeta.ts');

    expect(manager).toContain('DeleteCampaignButton');
    expect(manager).toContain('DeleteAdButton');
    expect(manager).toContain('<AlertDialogTitle>Supprimer cette ancienne campagne ?</AlertDialogTitle>');
    expect(manager).toContain("status: 'draft'");
    expect(campaignHooks).toContain('export function useStartAdCheckout()');
    expect(campaignHooks).not.toContain('export function useActivateAdCampaign()');
    expect(campaignHooks).toContain(".eq('advertiser_id', user.id)");
    expect(adHooks).toContain(".eq('advertiser_id', user.id)");
  });
});
