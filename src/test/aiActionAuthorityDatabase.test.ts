// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
let db: PGlite;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function role(value: string, user = 1) {
  await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [id(user)]); await db.exec(`set role ${value}`);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon,service_role;
    create table user_roles(user_id uuid,role text);
    create table posts(id uuid primary key,user_id uuid not null,body text,image_url text);
    create table comments(id uuid primary key default gen_random_uuid(),user_id uuid,post_id uuid references posts on delete cascade,
      parent_id uuid references comments on delete cascade,body text not null,is_zeus_reply boolean not null default false,
      check(user_id is not null or is_zeus_reply));
    create table content_strikes(id uuid primary key default gen_random_uuid(),user_id uuid not null,post_id uuid references posts on delete cascade,
      reason text,severity text,zeus_message text,acknowledged boolean default false,acknowledged_at timestamptz);
    create table comment_moderation_alerts(user_id uuid,comment_id uuid references comments,post_id uuid references posts,
      evidence_text text,category text,severity text,ai_reasoning text,strike_count integer,status text,reviewed_by uuid,reviewed_at timestamptz);
    create table feed_algorithm_config(key text primary key,value jsonb,updated_by uuid,updated_at timestamptz);
    alter table comments enable row level security;alter table content_strikes enable row level security;alter table comment_moderation_alerts enable row level security;
    create policy comment_read on comments for select to authenticated using(true);
    create policy comment_insert on comments for insert to authenticated with check(user_id=auth.uid() or is_zeus_reply);
    create policy comment_update on comments for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy strike_access on content_strikes for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy alerts_admin on comment_moderation_alerts for all to authenticated using(auth.uid()='${id(9)}');
    grant all on all tables in schema public to authenticated,service_role;
  `);
  await db.exec(readFileSync('supabase/migrations/20261022173654_harden_ai_action_and_moderation_authority.sql', 'utf8'));
}, 30000);
beforeEach(async () => {
  await db.exec(`reset role;truncate aegis_ai_authority.moderation_receipts,aegis_ai_authority.feed_config_audit,
    comment_moderation_alerts,content_strikes,comments,posts,user_roles,feed_algorithm_config;
    insert into user_roles values('${id(9)}','admin');
    insert into posts values('${id(1)}','${id(1)}','original',null),('${id(2)}','${id(2)}','other',null);
    insert into comments(id,user_id,post_id,body) values('${id(10)}','${id(1)}','${id(1)}','original');
    insert into feed_algorithm_config values('scoring_weights','{"friend_boost":8}',null,null),
      ('marketplace_injection','{"positions":[2,12,23],"products_per_section":6}',null,null);`);
  await role('service_role');
});
afterAll(async () => { await db?.close(); });
async function moderate(options: { actor?: number; text?: string; severity?: string; category?: string; reply?: string; kind?: string; content?: number } = {}) {
  return (await db.query<{ result: any }>('select apply_owned_content_moderation($1,$2,$3,$4,$5,$6,$7,$8,$9) as result', [
    options.kind ?? 'comment', id(options.content ?? 10), id(options.actor ?? 1), options.text ?? 'original', 'Synthetic reason',
    options.severity ?? 'warning', options.category ?? 'harassment', options.reply ?? 'Please be kind', '',
  ])).rows[0].result;
}
async function counts() {
  await db.exec('reset role');
  return (await db.query<{ strikes: number; replies: number; alerts: number; receipts: number }>(`select
    (select count(*)::int from content_strikes) as strikes,(select count(*)::int from comments where is_zeus_reply) as replies,
    (select count(*)::int from comment_moderation_alerts) as alerts,(select count(*)::int from aegis_ai_authority.moderation_receipts) as receipts`)).rows[0];
}
it('does not let a browser call server moderation or read the private receipts', async () => {
  for (const r of ['anon', 'authenticated']) {
    await role(r); await expect(moderate()).rejects.toThrow(/permission denied/);
    await expect(db.query('select * from aegis_ai_authority.moderation_receipts')).rejects.toThrow(/permission denied/);
  }
});
it('does not let a client impersonate Zeus or change its content identity', async () => {
  await role('authenticated');
  await expect(db.query(`insert into comments(user_id,post_id,body,is_zeus_reply) values($1,$2,'forged',true)`, [id(1), id(1)])).rejects.toThrow(/row-level security/);
  await expect(db.query('update comments set is_zeus_reply=true where id=$1', [id(10)])).rejects.toThrow(/row-level security/);
  await expect(db.query('update comments set post_id=$1 where id=$2', [id(2), id(10)])).rejects.toThrow(/COMMENT_IDENTITY_IMMUTABLE/);
  await expect(db.query('update comments set id=$1 where id=$2', [id(12), id(10)])).rejects.toThrow(/COMMENT_IDENTITY_IMMUTABLE/);
  await db.query("update comments set body='edited' where id=$1", [id(10)]);
});
it('keeps legitimate replies and rejects cross-post parent substitution', async () => {
  await role('authenticated');
  await db.query("insert into comments(user_id,post_id,parent_id,body) values($1,$2,$3,'reply')", [id(1), id(1), id(10)]);
  await expect(db.query("insert into comments(user_id,post_id,parent_id,body) values($1,$2,$3,'wrong parent')", [id(1), id(2), id(10)])).rejects.toThrow(/COMMENT_PARENT_POST_MISMATCH/);
});
it('cannot create its own strikes or alter the reason/severity; acknowledgment remains available', async () => {
  await moderate(); await role('authenticated');
  await expect(db.query("insert into content_strikes(user_id,reason) values($1,'forged')", [id(1)])).rejects.toThrow(/permission denied/);
  await expect(db.query("update content_strikes set reason='forged'")).rejects.toThrow(/permission denied/);
  expect((await db.query('update content_strikes set acknowledged=true returning id')).rows).toHaveLength(1);
});
it('records one strike/reply/receipt atomically and a retry keeps the original decision', async () => {
  expect(await moderate({ severity: 'critical' })).toMatchObject({ applied: true, replayed: false, strike_count: 1, escalated: true });
  expect(await moderate({ reply: 'changed retry' })).toMatchObject({ applied: true, replayed: true, zeus_reply: 'Please be kind',severity:'critical',reason:'Synthetic reason',category:'harassment' });
  expect(await counts()).toEqual({ strikes: 1, replies: 1, alerts: 1, receipts: 1 });
});
it('rechecks the canonical author and revision after the provider completes', async () => {
  expect(await moderate({ actor: 2 })).toMatchObject({ applied: false, reason: 'CONTENT_UNAVAILABLE' });
  expect(await moderate({ text: 'browser fabrication' })).toMatchObject({ applied: false, reason: 'CONTENT_CHANGED' });
  expect(await counts()).toEqual({ strikes: 0, replies: 0, alerts: 0, receipts: 0 });
});
it('a new revision may be reviewed but a retry cannot accumulate strikes', async () => {
  await moderate(); await db.query("update comments set body='revision two' where id=$1", [id(10)]);
  await moderate({ text: 'revision two' }); await moderate({ text: 'revision two' });
  expect(await counts()).toEqual({ strikes: 2, replies: 2, alerts: 0, receipts: 2 });
});
it('rolls back the strike, reply and receipt if the alert insert fails', async () => {
  await db.exec("reset role;alter table comment_moderation_alerts add constraint synthetic_failure check(category<>'spam')");
  try { await role('service_role'); await expect(moderate({ severity: 'critical', category: 'spam' })).rejects.toThrow(/synthetic_failure/);
    expect(await counts()).toEqual({ strikes: 0, replies: 0, alerts: 0, receipts: 0 });
  } finally { await db.exec('reset role;alter table comment_moderation_alerts drop constraint synthetic_failure'); }
});
it('post moderation produces no system comment and rechecks post ownership', async () => {
  expect(await moderate({ kind: 'post', content: 1 })).toMatchObject({ applied: true, strike_count: 1, escalated: false });
  expect(await moderate({ kind: 'post', content: 2 })).toMatchObject({ applied: false });
  expect(await counts()).toEqual({ strikes: 1, replies: 0, alerts: 0, receipts: 1 });
});
const config = async (actor = 9, updates: unknown = { friend_boost: 9 }, expected: unknown = { friend_boost: 8 }, key = 'scoring_weights') =>
  (await db.query<{ result: any }>('select apply_admin_feed_config_update($1,$2,$3,$4,$5) as result', [id(actor), key, JSON.stringify(updates), JSON.stringify(expected), 'Human confirmed synthetic test'])).rows[0].result;
it('never treats the browser role or a nonadmin actor as config authority', async () => {
  await expect(config(1)).rejects.toThrow(/ADMIN_REQUIRED/); await role('authenticated', 9); await expect(config()).rejects.toThrow(/permission denied/);
});
it('applies the exact validated change and audit in one transaction, without replacing the weights by default', async () => {
  expect((await db.query<{value:unknown}>('select value from feed_algorithm_config where key=$1', ['scoring_weights'])).rows[0].value).toEqual({ friend_boost: 8 });
  expect(await config()).toMatchObject({ applied: true, new_value: { friend_boost: 9 } });
  expect((await db.query('select actor_id,previous_value,new_value from aegis_ai_authority.feed_config_audit')).rows).toEqual([
    { actor_id: id(9), previous_value: { friend_boost: 8 }, new_value: { friend_boost: 9 } },
  ]);
  expect(await config()).toMatchObject({ applied: false, reason: 'FEED_CONFIG_CHANGED' });
});
const invalidPatches:unknown[]=[{ unknown_field: 3 }, { friend_boost: 'nine' }, { friend_boost: 1000001 }, { constructor: 1 }];
it.each(invalidPatches)('rejects an invalid config patch %j without writing', async updates => {
  await expect(config(9, updates)).rejects.toThrow(/FEED_/);
  expect((await db.query('select * from aegis_ai_authority.feed_config_audit')).rows).toHaveLength(0);
});
it('cannot commit a configuration if its audit fails', async () => {
  await db.exec('reset role;alter table aegis_ai_authority.feed_config_audit add constraint synthetic_audit_failure check(false) not valid');
  try { await role('service_role'); await expect(config()).rejects.toThrow(/synthetic_audit_failure/);
    expect((await db.query<{value:unknown}>('select value from feed_algorithm_config where key=$1', ['scoring_weights'])).rows[0].value).toEqual({ friend_boost: 8 });
  } finally { await db.exec('reset role;alter table aegis_ai_authority.feed_config_audit drop constraint synthetic_audit_failure'); }
});
