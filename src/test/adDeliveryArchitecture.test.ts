import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('secure ad delivery architecture', () => {
  it('does not treat an inactive parental-control record as an active minor restriction', () => {
    const migration = readSource('supabase/migrations/20261008130755_fix_inactive_parental_adult_gate.sql');
    expect(migration).toContain('controls.is_minor = true');
    expect(migration).toContain('controls.is_active = true');
  });

  it('serves sanitized paid creatives through a narrow placement RPC', () => {
    const migration = readSource('supabase/migrations/20260930120500_harden_and_improve_ad_delivery.sql');

    expect(migration).toContain('get_active_ads_for_placement');
    expect(migration).toContain("and campaign.paid_at is not null");
    expect(migration).toContain('p_placement = any(ad_set.placements)');
    expect(migration).toContain('ad.advertiser_id <> (select auth.uid())');
    expect(migration).not.toContain('target_interests text[]');
  });

  it('deduplicates events and makes counters server-owned', () => {
    const migration = readSource('supabase/migrations/20260930120500_harden_and_improve_ad_delivery.sql');

    expect(migration).toContain('ad_interactions_daily_unique_idx');
    expect(migration).toContain('on conflict do nothing');
    expect(migration).toContain('AD_METRICS_SERVER_ONLY');
    expect(migration).toContain('revoke insert, update, delete on public.ad_interactions from authenticated');
    expect(migration).toContain('revoke insert, update, delete on public.ad_daily_stats from authenticated');
  });
});
