import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const feedSource = readFileSync(
  resolve(process.cwd(), 'src/pages/Feed.tsx'),
  'utf8',
);

const migrationSource = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261008130000_restore_partner_media_delivery.sql',
  ),
  'utf8',
);

describe('partner news delivery reliability', () => {
  it('keeps the local media section visible even when focus mode is enabled', () => {
    expect(feedSource).toContain('<LocalMediaSection');
    expect(feedSource).not.toMatch(
      /!wellbeingPrefs\.focusModeEnabled\s*&&\s*<LocalMediaSection/,
    );
  });

  it('preserves approved RSS rows without reviving prior rejections', () => {
    expect(migrationSource).toContain('previously_approved_ids text[]');
    expect(migrationSource).toContain('m.partner_id=s.partner_id AND m.moderated');
    expect(migrationSource).toContain('external_id=ANY(previously_approved_ids)');
    expect(migrationSource).toContain('IF s.auto_publish THEN');
  });

  it('drains due RSS sources repeatedly instead of stopping after one batch', () => {
    expect(migrationSource).toContain('forsure-partner-rss-hourly');
    expect(migrationSource).toContain("'17 * * * *'");
    expect(migrationSource).toContain('private.partner_rss_daily_tick()');
  });
});

