// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table live_streams(id uuid primary key default gen_random_uuid(),user_id uuid,title text,description text,thumbnail_url text,
      is_active boolean,viewer_count integer,peak_viewer_count integer,total_views integer,category text,hashtags text[],recording_url text,
      started_at timestamptz,ended_at timestamptz,created_at timestamptz default now());
    create table profiles(user_id uuid,name text,avatar_url text);
    create function public.live_score_batch(uuid,integer) returns table(live_id uuid,score numeric) language sql as $$select id,0::numeric from live_streams$$;
    alter table live_streams enable row level security;
    create policy public_read on live_streams for select using(true);
    grant select on live_streams to anon,authenticated;
  `);
  // PostgreSQL WASM has no network/cron extensions: test the real schema,
  // trigger, RLS and serving function before the separate cron dispatcher.
  const migration=readFileSync('supabase/migrations/20261104215904_live_archive_lifecycle.sql','utf8');
  await db.exec(migration.slice(0,migration.indexOf('-- Store this function'))+'COMMIT;');
},30000);
afterAll(async()=>db?.close());
describe('server-owned broadcast clock and archive expiry',()=>{
  it('ignores a forged browser start and expiry, then freezes them',async()=>{
    const inserted=await db.query<{id:string,started_at:string}>(`insert into live_streams(user_id,is_active,started_at,archive_expires_at)
      values('11111111-1111-4111-8111-111111111111',true,now()+interval '10 years',now()+interval '10 years') returning id,started_at`);
    const row=inserted.rows[0];
    expect(Math.abs(Date.parse(row.started_at)-Date.now())).toBeLessThan(5000);
    await db.query(`update live_streams set started_at=now()+interval '1 year' where id=$1`,[row.id]);
    const updated=await db.query<{started_at:string}>(`select started_at from live_streams where id=$1`,[row.id]);
    expect(updated.rows[0].started_at).toEqual(row.started_at);
    await db.query(`update live_streams set is_active=false,ended_at=now()+interval '1 year' where id=$1`,[row.id]);
    const retention=await db.query<{days:number}>(`select extract(epoch from archive_expires_at-ended_at)/86400 as days from live_streams where id=$1`,[row.id]);
    expect(Number(retention.rows[0].days)).toBe(30);
    await expect(db.query(`update live_streams set is_active=true where id=$1`,[row.id])).rejects.toThrow('LIVE_ALREADY_ENDED');
  });
  it('hides expired archives from direct reads and from the feed bundle',async()=>{
    // Seed expired state as operator, without a user-editable expiry path.
    await db.exec(`alter table live_streams disable trigger guard_live_lifecycle;
      insert into live_streams(user_id,is_active,ended_at,archive_expires_at,recording_url)
      values('22222222-2222-4222-8222-222222222222',false,now()-interval '31 days',now()-interval '1 day','expired');
      alter table live_streams enable trigger guard_live_lifecycle; set role anon;`);
    const rows=await db.query(`select id from live_streams where recording_url='expired'`);
    expect(rows.rows).toHaveLength(0);
    const feed=await db.query<{bundle:{replays:{recording_url:string}[]}}>(`select public.live_feed_bundle(null) as bundle`);
    expect(feed.rows[0].bundle.replays.some(row=>row.recording_url==='expired')).toBe(false);
    await db.exec('reset role');
  });
});
