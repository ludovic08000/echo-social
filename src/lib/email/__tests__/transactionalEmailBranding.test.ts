import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

describe('transactional email branding', () => {
  it('uses Forsure for every server-side email sender', () => {
    const senderSources = [
      source('supabase/functions/send-transactional-email/index.ts'),
      source('supabase/functions/auth-email-hook/index.ts'),
    ];

    for (const senderSource of senderSources) {
      expect(senderSource).toContain('const SITE_NAME = "Forsure"');
      expect(senderSource).toContain('from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`');
      expect(senderSource).not.toContain('const SITE_NAME = "calm-connect-05"');
    }
  });
});
