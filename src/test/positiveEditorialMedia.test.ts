import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = readSource('supabase/migrations/20261008170000_positive_editorial_media.sql');
const panel = readSource('src/components/settings/ContentPreferencesPanel.tsx');
const media = readSource('src/components/feed/LocalMediaSection.tsx');
const deployment = readSource('.github/workflows/deploy-positive-editorial-media.yml');

describe('positive editorial media architecture', () => {
  it('persists an explicit bounded taxonomy and activates all four specialized lanes', () => {
    for (const category of ['science', 'music', 'education', 'wellbeing']) {
      expect(migration).toContain(`'${category}'`);
      expect(migration).toContain(`editorial_category`);
    }
    for (const source of ['cnrs-journal', 'france-musique', 'cafe-pedagogique', 'psychologies']) {
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

  it('prioritizes the first import of newly enabled editorial sources', () => {
    expect(migration.match(/next_fetch_at=to_timestamp\(0\)/g)).toHaveLength(1);
    expect(migration).toContain('true,true,to_timestamp(0)');
  });

  it('keeps news independent from advertising/adult gates and exposes the categories in the UI', () => {
    expect(migration).not.toContain('ad_adult_internal');
    expect(migration).not.toContain('family_safe=true');
    expect(panel).toContain("value: 'education'");
    expect(panel).toContain("value: 'wellbeing'");
    expect(panel).toContain("queryKey: ['partner-media', userId]");
    expect(media).toContain("science: 'Science'");
    expect(media).toContain("wellbeing: 'Bien-être'");
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
