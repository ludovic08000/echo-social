// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const actorId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;

    create table public.creator_subscriptions (
      user_id uuid primary key,
      status text not null,
      plan text not null,
      stripe_subscription_id text,
      current_period_end timestamptz
    );
    create table public.live_streams (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      title text not null
    );
    alter table public.creator_subscriptions enable row level security;
    alter table public.live_streams enable row level security;
    grant select, insert, update, delete on public.creator_subscriptions to authenticated;
    grant insert on public.live_streams to authenticated;
    create policy "Users can view their own subscription" on public.creator_subscriptions
      for select to authenticated using (auth.uid() = user_id);
    create policy "Users can insert their own subscription" on public.creator_subscriptions
      for insert to authenticated with check (auth.uid() = user_id);
    create policy "Users can update their own subscription" on public.creator_subscriptions
      for update to authenticated using (auth.uid() = user_id);
    create policy "Users can create lives" on public.live_streams
      for insert to authenticated with check (auth.uid() = user_id);
  `);
  await db.exec(readFileSync(
    'supabase/migrations/20261026223607_restrict_live_creation_to_paid_creators.sql',
    'utf8',
  ));
}, 30_000);

beforeEach(async () => {
  await db.exec(`
    reset role;
    truncate public.live_streams, public.creator_subscriptions;
    select set_config('test.uid', '${actorId}', false);
  `);
});

afterAll(async () => db?.close());

async function createLive(userId = actorId) {
  return db.query('insert into public.live_streams(user_id, title) values($1, $2)', [userId, 'Test']);
}

describe('paid creator live policy in PostgreSQL', () => {
  it('rejects an ordinary authenticated user', async () => {
    await db.exec('set role authenticated');
    await expect(createLive()).rejects.toThrow(/row-level security/);
  });

  it('rejects expired, unverified or wrong-plan subscriptions', async () => {
    const cases = [
      ['active', 'creator_monthly', 'sub_paid', "now() - interval '1 minute'"],
      ['active', 'creator_monthly', null, "now() + interval '1 day'"],
      ['active', 'free', 'sub_paid', "now() + interval '1 day'"],
      ['cancelled', 'creator_monthly', 'sub_paid', "now() + interval '1 day'"],
    ] as const;

    for (const [status, plan, stripeId, period] of cases) {
      await db.exec('reset role; truncate public.live_streams, public.creator_subscriptions');
      await db.query(
        `insert into public.creator_subscriptions(user_id,status,plan,stripe_subscription_id,current_period_end)
         values($1,$2,$3,$4,${period})`,
        [actorId, status, plan, stripeId],
      );
      await db.exec('set role authenticated');
      await expect(createLive()).rejects.toThrow(/row-level security/);
    }
  });

  it('allows only the paying creator to create their own live', async () => {
    await db.query(
      `insert into public.creator_subscriptions(user_id,status,plan,stripe_subscription_id,current_period_end)
       values($1,'active','creator_monthly','sub_paid',now() + interval '1 day')`,
      [actorId],
    );
    await db.exec('set role authenticated');
    await expect(createLive()).resolves.toBeDefined();
    await expect(createLive(otherId)).rejects.toThrow(/row-level security/);
  });

  it('cannot create or extend paid state from the browser role', async () => {
    await db.exec('set role authenticated');
    await expect(db.query(
      `insert into public.creator_subscriptions(user_id,status,plan,stripe_subscription_id,current_period_end)
       values($1,'active','creator_monthly','forged',now() + interval '1 year')`,
      [actorId],
    )).rejects.toThrow(/permission denied/);
  });
});
