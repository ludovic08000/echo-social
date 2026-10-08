import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const baseMigration = readSource('supabase/migrations/20261008170000_positive_editorial_media.sql');
const freshnessMigration = readSource('supabase/migrations/20261008204946_fresh_daily_sport_media.sql');
const mlCompatibilityMigration = readSource('supabase/migrations/20261008210755_align_editorial_media_with_user_ml.sql');
const migration = `${baseMigration}\n${freshnessMigration}\n${mlCompatibilityMigration}`;
const panel = readSource('src/components/settings/ContentPreferencesPanel.tsx');
const media = readSource('src/components/feed/LocalMediaSection.tsx');
const deployment = readSource('.github/workflows/deploy-positive-editorial-media.yml');

describe('positive editorial media architecture', () => {
  it('persists an explicit bounded taxonomy and activates all five specialized lanes', () => {
    for (const category of ['science', 'music', 'education', 'wellbeing', 'sport']) {
      expect(migration).toContain(`'${category}'`);
      expect(migration).toContain(`editorial_category`);
    }
    for (const source of ['cnrs-journal', 'france-musique', 'cafe-pedagogique', 'psychologies', 'franceinfo-sports']) {
      expect(migration).toContain(`'${source}'`);
    }
  });

  it('round-robins categories, respects account preferences and retains publisher diversity', () => {
    expect(migration).toContain('PARTITION BY editorial_category');
    expect(migration).toContain('category_number');
    expect(migration).toContain('preferences.priority_topics');
    expect(migration).toContain('PARTITION BY website_host,editorial_category');
    expect(migration).toContain('publisher_number<=3');
    expect(migration).toContain('LIMIT 16');
  });

  it('uses the same explicit taxonomy and a user-controlled news weight as the social ML feed', () => {
    expect(mlCompatibilityMigration).toContain('weight_news');
    expect(mlCompatibilityMigration).toContain('feed_normalize_topic');
    expect(mlCompatibilityMigration).toContain("v_topic = 'education'");
    expect(mlCompatibilityMigration).toContain("v_topic = 'wellbeing'");
    expect(mlCompatibilityMigration).toContain("interests.explicit");
    expect(mlCompatibilityMigration).not.toContain('public.messages');
  });

  it('prioritizes the first import of newly enabled editorial sources', () => {
    expect(migration.match(/next_fetch_at=to_timestamp\(0\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain('true,true,to_timestamp(0)');
  });

  it('hides stale cards without deleting their discussion rows', () => {
    expect(freshnessMigration).toContain("m.published_at>now()-interval '36 hours'");
    expect(freshnessMigration).not.toContain('DELETE FROM public.partner_media_items');
  });

  it('keeps news independent from advertising/adult gates and exposes the categories in the UI', () => {
    expect(migration).not.toContain('ad_adult_internal');
    expect(migration).not.toContain('family_safe=true');
    expect(panel).toContain("value: 'education'");
    expect(panel).toContain("value: 'wellbeing'");
    expect(panel).toContain("queryKey: ['partner-media', userId]");
    expect(media).toContain("science: 'Science'");
    expect(media).toContain("wellbeing: 'Bien-être'");
    expect(media).toContain("sport: 'Sport'");
  });

  it('fails closed and rotates the Cloud scheduler secret without exposing it', () => {
    expect(deployment).toContain('PARTNER_RSS_CRON_SECRET_NEXT');
    expect(deployment).toContain('::add-mask::');
    expect(deployment).toContain('vault.update_secret');
    expect(deployment).toContain('vault.create_secret');
    expect(deployment).toContain('supabase secrets unset PARTNER_RSS_CRON_SECRET_NEXT');
    expect(deployment).not.toContain('decrypted_secret as cron_secret');
    expect(deployment).not.toContain('cat "$RUNNER_TEMP/rss-scheduler.env"');
    expect(deployment).toContain("if: failure() && steps.migrate.outcome == 'success'");
    expect(deployment).toContain('set enabled=false,lease_token=null,lease_until=null');
    expect(deployment).toContain('set active=false');
  });
});
