// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationSource = readFileSync(
  'supabase/migrations/20261027160000_voice_session_tickets.sql',
  'utf8',
);
const migration = migrationSource.toLowerCase();
const edgeFunction = readFileSync('supabase/functions/voice-session/index.ts', 'utf8');

describe('secure voice session tickets', () => {
  it('keeps the ephemeral ticket table compatible with Lovable Cloud', () => {
    expect(migration).toContain('user_id uuid not null');
    expect(migration).not.toContain('references auth.users');
    expect(migration).toContain('alter table public.voice_session_tickets enable row level security');
    expect(migration).toContain('revoke all on public.voice_session_tickets from anon, authenticated');
    expect(migration).toContain('grant select, insert, update, delete on public.voice_session_tickets to service_role');
  });

  it('authenticates the issuer server-side before storing its user id', () => {
    expect(edgeFunction).toContain('await authClient.auth.getUser()');
    expect(edgeFunction).toContain("if (error || !user) return json(req, { error: 'unauthorized' }, 401)");
    expect(edgeFunction).toContain('user_id: user.id');
    expect(edgeFunction).not.toContain('body.user_id');
  });

  it('keeps tickets short-lived, origin-bound and single-use', () => {
    expect(edgeFunction).toContain('const TTL_MS = 60_000');
    expect(migration).toContain("allowed_origin ~ '^https://[^/]+$'");
    expect(migration).toContain("expires_at <= created_at + interval '2 minutes'");
    expect(migration).toContain('consumed_at is null');
    expect(migration).toContain('expires_at > now()');
    expect(migration).toContain('set consumed_at = now()');
  });

  it('protects ticket exchange with the internal service secret', () => {
    expect(edgeFunction).toContain("req.headers.get('x-voice-service-secret')");
    expect(edgeFunction).toContain("Deno.env.get('VOICE_SERVICE_SECRET')");
    expect(edgeFunction).toContain("return json(req, { error: 'invalid_ticket' }, 401)");
  });

  it('applies cleanly and atomically consumes a live ticket only once', async () => {
    const db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(migrationSource);

    const userId = crypto.randomUUID();
    await db.query(
      `insert into public.voice_session_tickets
        (ticket_hash, user_id, nonce, allowed_origin, audience, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '60 seconds')`,
      ['ticket-hash', userId, 'n'.repeat(32), 'https://voice.forsure.fans', 'forsure-voice'],
    );

    const first = await db.query<{ user_id: string }>(
      'select user_id from public.consume_voice_session_ticket($1, $2, $3)',
      ['ticket-hash', 'https://voice.forsure.fans', 'forsure-voice'],
    );
    const replay = await db.query<{ user_id: string }>(
      'select user_id from public.consume_voice_session_ticket($1, $2, $3)',
      ['ticket-hash', 'https://voice.forsure.fans', 'forsure-voice'],
    );

    expect(first.rows).toEqual([{ user_id: userId }]);
    expect(replay.rows).toEqual([]);
    await db.close();
  });
});
