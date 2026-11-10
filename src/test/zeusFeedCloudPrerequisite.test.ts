// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table profiles(user_id uuid primary key references auth.users(id) on delete cascade);
    insert into auth.users values('${owner}'),('${other}');insert into profiles select id from auth.users;
    create table user_feed_preferences(user_id uuid primary key,feed_algorithm text not null default 'smart',
      diversity_boost integer not null default 50,muted_keywords text[] not null default '{}',priority_topics text[] not null default '{}',
      viral_content_reduce boolean not null default false,sensitive_content_filter boolean not null default true,seen_posts_hide boolean not null default false,
      weight_friends integer not null default 50,weight_discovery integer not null default 50,weight_marketplace integer not null default 50,
      created_at timestamptz default now(),updated_at timestamptz default now());
    create table posts(id uuid primary key,body text);
    create table ml_post_features(post_id uuid primary key,topics text[]);
    alter table user_feed_preferences enable row level security;
    create policy own_preferences on user_feed_preferences for select to authenticated using(user_id=auth.uid());
    grant select on user_feed_preferences to authenticated;`);
  await db.exec(readFileSync('supabase/migrations/20261027120000_feed_explicit_control.sql','utf8'));
},30000);
afterAll(async()=>db?.close());
it('applies the actual feed RPC, reads only own history and reverses the change',async()=>{
  await db.exec(`select set_config('test.uid','${owner}',false);set role authenticated`);
  const result=await db.query<{change_id:string;applied_state:{priority_topics:string[]}}>(
    'select * from apply_feed_preference_command($1,$2)', ['Plus de science',{more_topics:['Science']}]);
  const id=result.rows[0].change_id;
  expect(result.rows[0].applied_state.priority_topics).toEqual(['science']);
  expect((await db.query('select * from feed_preference_change_history')).rows).toHaveLength(1);
  await db.exec(`select set_config('test.uid','${other}',false)`);
  expect((await db.query('select * from feed_preference_change_history')).rows).toHaveLength(0);
  await expect(db.query('select undo_feed_preference_change($1)',[id])).rejects.toThrow(/ONLY_LATEST_CHANGE/);
  await db.exec(`select set_config('test.uid','${owner}',false)`);
  const undone=await db.query<{state:{priority_topics:string[]}}>('select undo_feed_preference_change($1) state',[id]);
  expect(undone.rows[0].state.priority_topics).toEqual([]);
  await expect(db.query('delete from feed_preference_change_history')).rejects.toThrow(/permission denied/);
  await db.exec('reset role;set role anon');
  await expect(db.query('select * from feed_preference_change_history')).rejects.toThrow(/permission denied/);
  await db.exec('reset role');
});
it('removes the personal history when its canonical profile is deleted',async()=>{
  await db.query('delete from profiles where user_id=$1',[owner]);
  expect((await db.query('select * from feed_preference_change_history where user_id=$1',[owner])).rows).toHaveLength(0);
});
