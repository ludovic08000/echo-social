// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
let db:PGlite;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const login=async(n:number|null)=>{await db.exec('reset role');await db.query("select set_config('test.uid',$1,false)",[n?id(n):'']);await db.exec(n?'set role authenticated':'set role anon')};
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;
    create table posts(id uuid primary key,user_id uuid,body text,publish_at timestamptz,expires_at timestamptz);
    alter table posts enable row level security;create policy old_read on posts for select using(true);
    create table profiles(user_id uuid primary key);
    create table privacy_settings(user_id uuid,profile_visibility text,posts_visibility text);
    create table friendships(requester_id uuid,addressee_id uuid,status text);
    create table user_message_blocks(blocker_user_id uuid,blocked_user_id uuid);
    create table fan_subscriptions(creator_id uuid,fan_id uuid,status text,current_period_end timestamptz);
    create table user_feed_preferences(user_id uuid,muted_keywords text[],sensitive_content_filter boolean,seen_posts_hide boolean);
    create table ml_post_features(post_id uuid,content_sensitivity_score numeric,topics text[],hashtags text[]);
    create table ml_interactions(user_id uuid,post_id uuid,signal_type text);
    create table parental_controls(user_id uuid,is_active boolean,is_minor boolean,allowed_categories text[]);
    create function parental_content_category_allowed(text,text[],text[],text[]) returns boolean language sql as $$select true$$;
    create table live_streams(id int,stream_key text,title text);create table seller_profiles(user_id uuid,total_revenue numeric,store_name text);
    create table ai_agents(id int,system_prompt text,name text);
    grant all on all tables in schema public to anon,authenticated,service_role;
  `);
  await db.exec(readFileSync('supabase/migrations/20261018203727_secure_post_visibility_and_private_columns.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261018204251_revoke_sensitive_columns_after_client_rollout.sql','utf8'));
  await db.exec(`grant execute on function feed_eligible_post_ids_internal(uuid,uuid[]) to service_role;
    insert into live_streams values(1,'synthetic-secret','Public live');insert into ai_agents values(1,'private prompt','Zeus');
    insert into seller_profiles values('${id(1)}',123,'Shop');`);
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate posts,profiles,privacy_settings,friendships,user_message_blocks,fan_subscriptions;
    insert into profiles values('${id(1)}'),('${id(2)}');
    insert into posts(id,user_id,body) values('${id(10)}','${id(1)}','public');`);
  await login(2);
});
afterAll(async()=>{await db?.close()});
const visible=()=>db.query('select id from posts');
const eligible=async()=>{await db.exec('reset role');return db.query('select * from feed_eligible_post_ids_internal($1,$2)',[id(2),[id(10)]])};
it('preserves public social posts for signed-in and anonymous visitors',async()=>{
  expect((await visible()).rows).toHaveLength(1);await login(null);expect((await visible()).rows).toHaveLength(1);
});
it('requires a current subscription in both direct reads and the definer feed',async()=>{
  await db.exec('reset role');await db.query('update posts set subscriber_only=true');await login(2);
  expect((await visible()).rows).toHaveLength(0);expect((await eligible()).rows).toHaveLength(0);
  await db.query("insert into fan_subscriptions values($1,$2,'active',now()+interval '1 day')",[id(1),id(2)]);
  await login(2);expect((await visible()).rows).toHaveLength(1);expect((await eligible()).rows).toHaveLength(1);
  await db.query("update fan_subscriptions set current_period_end=now()-interval '1 day'");
  await login(2);expect((await visible()).rows).toHaveLength(0);
});
it.each(['blocked','scheduled','expired','friends-only'])('enforces %s in the direct read and ranked feed',async mode=>{
  await db.exec('reset role');
  if(mode==='blocked') await db.query('insert into user_message_blocks values($1,$2)',[id(1),id(2)]);
  if(mode==='scheduled') await db.query("update posts set publish_at=now()+interval '1 day'");
  if(mode==='expired') await db.query("update posts set expires_at=now()-interval '1 day'");
  if(mode==='friends-only') await db.query("insert into privacy_settings values($1,'friends','friends')",[id(1)]);
  await login(2);expect((await visible()).rows).toHaveLength(0);expect((await eligible()).rows).toHaveLength(0);
});
it('preserves author access to their own draft or subscriber-only post',async()=>{
  await db.exec('reset role');await db.query("update posts set subscriber_only=true,publish_at=now()+interval '1 day'");
  await login(1);expect((await visible()).rows).toHaveLength(1);
});
it('denies selecting the sensitive column even with old broad table grants',async()=>{
  await login(null);expect((await db.query('select title from live_streams')).rows).toHaveLength(1);
  await expect(db.query('select stream_key from live_streams')).rejects.toThrow(/permission denied/);
  await expect(db.query('select total_revenue from seller_profiles')).rejects.toThrow(/permission denied/);
  await expect(db.query('select system_prompt from ai_agents')).rejects.toThrow(/permission denied/);
});
it('returns financial data only to the seller owner through their scoped RPC',async()=>{
  expect((await db.query('select my_seller_profile() as p')).rows[0]).toEqual({p:null});
  await login(1);expect((await db.query<{p:unknown}>('select my_seller_profile() as p')).rows[0].p).toMatchObject({total_revenue:123});
  await expect(db.query('update fan_subscriptions set status=\'active\'')).rejects.toThrow(/permission denied/);
});
