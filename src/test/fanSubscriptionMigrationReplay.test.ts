// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('replays the missing immutable Cloud history before private-post hardening, preserving payment authority',async()=>{
  const source=readFileSync('supabase/migrations/20261009021231_fan_subscriptions_and_market_badge.sql','utf8').replace(/\r\n/g,'\n');
  const cloud=readFileSync('drizzle/migrations/0026_fan_subscriptions_and_market_badge.sql','utf8').replace(/\r\n/g,'\n');
  expect(source).toBe(cloud);
  const db=new PGlite();
  const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;
      create table profiles(user_id uuid primary key);
      create table creator_subscriptions(user_id uuid,status text);
      create table posts(id uuid primary key,user_id uuid,body text);
      create table seller_profiles(id uuid primary key,user_id uuid);
      create table products(id uuid primary key,seller_id uuid,is_active boolean);
      alter table posts enable row level security;alter table products enable row level security;alter table seller_profiles enable row level security;
      create policy "Posts respect owner privacy" on posts for select using(true);
      create policy "Sellers can create products" on products for insert with check(true);
      create policy "Users can create their own seller profile" on seller_profiles for insert with check(true);
      create function update_updated_at_column() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
      create function privacy_scope_allows(uuid,text) returns boolean language sql stable as $$select true$$;
      create function current_viewer_parental_post_allowed(uuid,text) returns boolean language sql stable as $$select true$$;
      insert into profiles values('${owner}'),('${other}');`);
    await db.exec(source);
    await db.query('insert into fan_clubs(creator_id) values($1),($2)',[owner,other]);
    await db.query("insert into fan_subscriptions(creator_id,fan_id,amount_cents,commission_cents,creator_payout_cents) values($1,$2,299,75,224)",[owner,other]);
    await db.exec(`select set_config('test.uid','${other}',false);set role authenticated`);
    expect((await db.query('select * from fan_clubs')).rows).toHaveLength(1);
    expect((await db.query('select * from fan_subscriptions')).rows).toHaveLength(1);
    await expect(db.query("update fan_subscriptions set status='active'")).rejects.toThrow(/permission denied/);
    await db.exec("select set_config('test.uid','33333333-3333-4333-8333-333333333333',false)");
    expect((await db.query('select * from fan_subscriptions')).rows).toHaveLength(0);
    await db.exec('reset role;set role anon');
    await expect(db.query('select * from fan_subscriptions')).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
    expect((await db.query("select column_default from information_schema.columns where table_name='posts' and column_name='subscriber_only'")).rows[0]).toMatchObject({column_default:'false'});
  }finally{await db.close();}
},30000);
