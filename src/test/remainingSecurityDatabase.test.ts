// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
let db:PGlite;
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated,service_role;
    create table friendships(id uuid primary key default gen_random_uuid(),requester_id uuid,addressee_id uuid,status text default 'pending',created_at timestamptz default now());
    alter table friendships enable row level security;
    create table ai_agents(id uuid primary key,is_active bool,free_messages_per_day integer);
    create table creator_subscriptions(user_id uuid,status text,current_period_end timestamptz);
    create table ai_agent_usage(id uuid primary key default gen_random_uuid(),user_id uuid,agent_id uuid,usage_date date,message_count integer default 0,unique(user_id,agent_id,usage_date));
    create table privacy_settings(user_id uuid,ai_data_sharing_enabled bool,ai_personalization_enabled bool,profile_visibility text,posts_visibility text);
    create table posts(id uuid primary key,user_id uuid,body text,image_url text,created_at timestamptz default now(),likes_count integer default 0,comments_count integer default 0,subscriber_only bool default false,publish_at timestamptz,expires_at timestamptz);
    create table feed_feature_jobs(post_id uuid primary key,status text,attempts integer default 0,available_at timestamptz default now(),lease_until timestamptz,revision uuid,updated_at timestamptz);
    create table ml_post_features(post_id uuid primary key,embedding text,topics text[],hashtags text[],sentiment numeric,quality_score numeric,language text,has_media bool,creator_id uuid,embedding_text text,embedding_source text,embedding_updated_at timestamptz,updated_at timestamptz);
    grant all on all tables in schema public to authenticated,service_role;
  `);
  const friendship=readFileSync('supabase/migrations/20261018203440_secure_social_and_privileged_authority.sql','utf8');
  await db.exec(friendship.slice(friendship.indexOf('-- Une relation'),friendship.indexOf('-- Les mesures')));
  const login=readFileSync('supabase/migrations/20260422052252_4a975c01-1e7b-490d-81bb-3ebe7b833cde.sql','utf8');
  await db.exec(login.slice(login.indexOf('CREATE TABLE IF NOT EXISTS public.login_attempts'),login.indexOf('-- 2) DEVICE-LINK')));
  await db.exec(readFileSync('supabase/migrations/20261018210942_harden_remaining_social_and_ai_authority.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate ai_usage_reservations,ai_agent_usage,creator_subscriptions,ai_agents,friendships,login_attempts,privacy_settings,posts,feed_feature_jobs,ml_post_features;
    insert into ai_agents values('${uid(9)}',true,2);select set_config('test.uid','${uid(2)}',false);set role service_role;`);
});
afterAll(async()=>{await db?.close()});
const reserve=(request=uid(20),user=uid(1))=>db.query<{r:{allowed:boolean}}>('select reserve_ai_agent_usage($1,$2,$3) as r',[user,uid(9),request]);
const finish=(id:string,success:boolean)=>db.query<{r:boolean}>('select finish_ai_agent_usage($1,$2) as r',[id,success]);
it('denies browser quota reservations, settlement and privileged login records',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await expect(reserve()).rejects.toThrow(/permission denied/);
    await expect(finish(uid(20),false)).rejects.toThrow(/permission denied/);
    await expect(db.query("select record_login_attempt('ip','hash',false,null)")).rejects.toThrow(/permission denied/);
    await expect(db.query("select check_login_rate_limit('ip','hash')")).rejects.toThrow(/permission denied/);
  }
});
it('admits at most two concurrent free generations and ignores request replay',async()=>{
  const results=await Promise.all(Array.from({length:8},(_,i)=>reserve(uid(20+i))));
  expect(results.filter(r=>r.rows[0].r.allowed)).toHaveLength(2);
  expect((await reserve(uid(20))).rows[0].r.allowed).toBe(true);
  expect((await db.query('select message_count from ai_agent_usage')).rows[0]).toEqual({message_count:2});
  await expect(reserve(uid(20),uid(3))).rejects.toThrow('USAGE_REQUEST_BINDING_MISMATCH');
});
it('refunds failure exactly once and never refunds a committed generation',async()=>{
  await reserve(uid(20));await reserve(uid(21));
  expect((await finish(uid(20),false)).rows[0].r).toBe(true);
  await finish(uid(20),false);
  expect((await db.query('select message_count from ai_agent_usage')).rows[0]).toEqual({message_count:1});
  await finish(uid(21),true);
  expect((await finish(uid(21),false)).rows[0].r).toBe(false);
  expect((await reserve(uid(22))).rows[0].r.allowed).toBe(true);
  expect((await reserve(uid(23))).rows[0].r.allowed).toBe(false);
});
it('an expired subscription cannot bypass a daily limit but a current one can',async()=>{
  await db.query("insert into creator_subscriptions values($1,'active',now()-interval '1 day')",[uid(1)]);
  await reserve(uid(20));await reserve(uid(21));
  expect((await reserve(uid(22))).rows[0].r.allowed).toBe(false);
  await db.query("update creator_subscriptions set current_period_end=now()+interval '1 day'");
  expect((await reserve(uid(22))).rows[0].r.allowed).toBe(true);
});
it('enforces the existing 5000-friend cap even when most rows are hidden by RLS',async()=>{
  await db.exec(`reset role;alter table friendships disable trigger enforce_friendship_capacity;
    insert into friendships(requester_id,addressee_id,status)select '${uid(1)}',('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'accepted' from generate_series(1,5000)n;
    alter table friendships enable trigger enforce_friendship_capacity;
    insert into friendships(id,requester_id,addressee_id)values('${uid(30)}','${uid(1)}','${uid(2)}');set role authenticated;`);
  expect((await db.query('select id from friendships')).rows).toHaveLength(1);
  await expect(db.query("update friendships set status='accepted' where id=$1",[uid(30)])).rejects.toThrow('FRIEND_LIMIT_REACHED');
  await db.query("update friendships set status='rejected' where id=$1",[uid(30)]);
});
it('ignores legacy browser failure reports and enforces verified server failures',async()=>{
  await db.exec(`reset role;insert into login_attempts(ip_address,email_hash,success)select 'ip','hash',false from generate_series(1,30);set role service_role;`);
  const check=()=>db.query<{r:{allowed:boolean}}>("select check_login_rate_limit('ip','hash') as r");
  expect((await check()).rows[0].r.allowed).toBe(true);
  for(let i=0;i<8;i++)await db.query("select record_login_attempt('ip','hash',false,null)");
  expect((await check()).rows[0].r.allowed).toBe(false);
});
it('excludes subscriber-only content from public AI training claims',async()=>{
  await db.query("insert into privacy_settings values($1,true,true,'public','public')",[uid(1)]);
  await db.query('insert into posts(id,user_id,body,subscriber_only) values($1,$3,$4,false),($2,$3,$4,true)',[uid(40),uid(41),uid(1),'Example']);
  await db.query("insert into feed_feature_jobs(post_id,status)values($1,'pending'),($2,'pending')",[uid(40),uid(41)]);
  expect((await db.query('select post_id from claim_feed_feature_jobs(40)')).rows).toEqual([{post_id:uid(40)}]);
});
