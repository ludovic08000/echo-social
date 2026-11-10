// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create type public.app_role as enum ('admin','moderator','user');
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${owner}'),('${other}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select current_user::text$$;
    create function public.has_role(p_user uuid,p_role public.app_role) returns boolean language sql stable as $$select p_role='admin' and p_user::text=nullif(current_setting('test.admin',true),'')$$;
    create function public.voice_command_access() returns boolean language sql stable as $$select coalesce(nullif(current_setting('test.voice',true),'')::boolean,true)$$;
    create table creator_subscriptions(user_id uuid,status text,plan text,stripe_subscription_id text,current_period_end timestamptz);
    create table test_feed_changes(id uuid default gen_random_uuid(),user_id uuid,command jsonb);
    create function public.apply_feed_preference_command(p_summary text,p_command jsonb) returns table(change_id uuid) language sql as $$insert into public.test_feed_changes(user_id,command) values(auth.uid(),p_command) returning id$$;
    grant usage on schema auth to authenticated,service_role;
    create table notifications(id uuid primary key default gen_random_uuid(),user_id uuid,type text,post_id uuid,actor_id uuid,read_at timestamptz,created_at timestamptz default now());
    create table posts(id uuid primary key,user_id uuid);
    create table profiles(user_id uuid primary key references auth.users(id) on delete cascade,name text,avatar_url text);
    grant select on profiles to authenticated;
    create type public.friendship_status as enum ('pending','accepted','rejected');
    create table friendships(id uuid primary key default gen_random_uuid(),requester_id uuid,addressee_id uuid,status public.friendship_status,created_at timestamptz default now());
    create table test_conversations(user_id uuid,unread_count bigint);
    create function public.get_conversations_with_details(p_user_id uuid) returns table(unread_count bigint) language sql stable as $$
      select c.unread_count from public.test_conversations c where c.user_id=auth.uid() and p_user_id=auth.uid()$$;
    alter table notifications enable row level security;
    create policy own_notification on notifications for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy native_notification_insert on notifications for insert to authenticated with check(actor_id=auth.uid() and actor_id<>user_id);
    grant select,insert,update,delete on notifications to authenticated;
    alter table friendships enable row level security;
    create policy own_friend_request on friendships for select to authenticated
      using(requester_id=auth.uid() or addressee_id=auth.uid());
    create policy answer_own_friend_request on friendships for update to authenticated
      using(addressee_id=auth.uid()) with check(addressee_id=auth.uid());
    grant select on posts,friendships,test_conversations to authenticated;
    grant update(status) on friendships to authenticated;`);
  const nativeGuard=readFileSync('supabase/migrations/20261018210942_harden_remaining_social_and_ai_authority.sql','utf8');
  await db.exec(nativeGuard.slice(nativeGuard.indexOf('create function public.enforce_friendship_capacity()'),nativeGuard.indexOf('create table public.ai_usage_reservations')));
  await db.exec(readFileSync('supabase/migrations/20261109175107_zeus_activity_notification_retention.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261109212104_zeus_capability_execution.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate notifications,posts,profiles,friendships,test_conversations,creator_subscriptions,test_feed_changes,zeus_private.command_receipts,zeus_private.policy_audit;
    update zeus_private.capability_policies set enabled=true,require_confirmation=minimum_confirmation,required_role=null,paid_only=false,revision=1;
    insert into profiles values('${owner}','Owner',null),('${other}','Other',null);
    select set_config('test.uid','${owner}',false),set_config('test.admin','',false),set_config('test.voice','true',false);`);
});
afterAll(async()=>db?.close());
async function summary(){return (await db.query<{value:Record<string,number>}>('select zeus_activity_summary() as value')).rows[0].value;}
it('counts beyond 50 notifications and binds messages, replies and friend requests to the authenticated account',async()=>{
  await db.query('insert into posts values($1,$1),($2,$2)',[owner,other]);
  await db.query(`insert into notifications(user_id,type,post_id) select $1,'comment',$1 from generate_series(1,65)`,[owner]);
  await db.query(`insert into notifications(user_id,type,post_id) values($1,'comment',$2),($2,'comment',$2)`,[owner,other]);
  await db.query('insert into test_conversations values($1,2),($1,4),($2,100)',[owner,other]);
  await db.query(`insert into profiles values($1,'Alice',null),($2,'Bob',null) on conflict(user_id) do update set name=excluded.name`,[owner,other]);
  await db.query(`insert into friendships(requester_id,addressee_id,status) values
    ($2,$1,'pending'),($2,$1,'pending'),($2,$1,'accepted'),($1,$2,'pending')`,[owner,other]);
  await db.exec('set role authenticated');
  expect(await summary()).toMatchObject({unread_messages:6,unread_notifications:66,publication_replies:65,friend_requests:2,
    friend_requests_preview:[{requester_id:other,name:'Bob'},{requester_id:other,name:'Bob'}]});
});
it('hides expired read and unread notifications with the same rules used by the spoken summary',async()=>{
  await db.query(`insert into notifications(user_id,type,created_at,read_at) values
    ($1,'comment',now()-interval '31 days',now()),($1,'comment',now()-interval '91 days',null),($1,'comment',now(),null)`,[owner]);
  await db.exec('set role authenticated');
  expect((await db.query('select * from notifications')).rows).toHaveLength(1);
  expect(await summary()).toMatchObject({unread_notifications:1});
});
it('dry-runs, archives with rollback time, then physically deletes only after seven days',async()=>{
  await db.query(`insert into notifications(user_id,type,created_at) values($1,'comment',now()-interval '100 days')`,[owner]);
  const dry=(await db.query<{value:{eligible_to_archive:number}}> ('select purge_old_notifications(true) as value')).rows[0].value;
  expect(dry.eligible_to_archive).toBe(1);
  expect((await db.query('select * from notifications where archived_at is null')).rows).toHaveLength(1);
  const first=(await db.query<{value:{archived:number;deleted:number}}> ('select purge_old_notifications(false) as value')).rows[0].value;
  expect(first).toMatchObject({archived:1,deleted:0});
  await db.exec(`update notifications set archived_at=now()-interval '8 days'`);
  const last=(await db.query<{value:{deleted:number}}> ('select purge_old_notifications(false) as value')).rows[0].value;
  expect(last.deleted).toBe(1);
});
it('denies purge and retention changes to an ordinary user',async()=>{
  await db.query(`insert into notifications(user_id,type) values($1,'comment')`,[owner]);
  await db.exec('set role authenticated');
  await expect(db.query('select purge_old_notifications(false)')).rejects.toThrow(/permission denied/);
  await expect(db.query('update notifications set archived_at=now()')).rejects.toThrow(/SERVER_ONLY/);
});
it('never returns invented zero counts for an unsigned user',async()=>{
  await db.exec(`select set_config('test.uid','',false);set role authenticated;`);
  await expect(summary()).rejects.toThrow(/CAPABILITY_DENIED/);
  await db.exec('set role anon');
  await expect(summary()).rejects.toThrow(/permission denied/);
});

const fingerprint='a'.repeat(64);
async function claim(key='same',cap='messages.send',confirmed=true,prepared=new Date().toISOString(),voice=false){
  return (await db.query<{value:{claimed:boolean}}>('select zeus_claim_command($1,$2,$3,$4,$5,$6) value',[key,cap,fingerprint,prepared,voice,confirmed])).rows[0].value;
}
it('binds a durable command key to the actor and rejects replay, changed content and expired confirmation',async()=>{
  await db.exec('set role authenticated');
  expect((await claim()).claimed).toBe(true);
  expect((await claim()).claimed).toBe(false);
  await expect(db.query('select zeus_claim_command($1,$2,$3,now(),false,true)',['same','messages.send','b'.repeat(64)])).rejects.toThrow(/COMMAND_CHANGED/);
  await expect(claim('expired','messages.send',true,new Date(Date.now()-6*60_000).toISOString())).rejects.toThrow(/EXPIRED/);
  await expect(claim('unconfirmed','messages.send',false)).rejects.toThrow(/CONFIRMATION_REQUIRED/);
  await db.query("select set_config('test.uid',$1,false)",[other]);
  expect((await claim()).claimed).toBe(true);
  await expect(db.query('select * from zeus_private.command_receipts')).rejects.toThrow(/permission denied/);
});
it('refuses disabled capabilities, a missing role, unpaid subscription and revoked voice access',async()=>{
  await db.exec("update zeus_private.capability_policies set enabled=false where capability='activity.read';set role authenticated");
  await expect(summary()).rejects.toThrow(/CAPABILITY_DENIED/);
  await db.exec("reset role;update zeus_private.capability_policies set required_role='admin' where capability='messages.send';set role authenticated");
  await expect(claim()).rejects.toThrow(/CAPABILITY_DENIED/);
  await db.exec("reset role;update zeus_private.capability_policies set required_role=null,paid_only=true where capability='messages.send';set role authenticated");
  await expect(claim()).rejects.toThrow(/CAPABILITY_DENIED/);
  await db.exec("reset role;update zeus_private.capability_policies set paid_only=false where capability='messages.send';set role authenticated;select set_config('test.voice','false',false)");
  await expect(claim('voice','messages.send',true,new Date().toISOString(),true)).rejects.toThrow(/CAPABILITY_DENIED/);
});
it('updates a policy only as administrator, audits it and refuses weaker confirmation or stale revisions',async()=>{
  await db.exec('set role authenticated');
  const update="select zeus_set_capability_policy('messages.send',false,null,false,true,1)";
  await expect(db.query(update)).rejects.toThrow(/ADMIN_REQUIRED/);
  await db.query("select set_config('test.admin',$1,false)",[owner]);
  await db.query(update);
  await expect(db.query(update)).rejects.toThrow(/POLICY_CHANGED/);
  await expect(db.query("select zeus_set_capability_policy('messages.send',true,null,false,false,2)")).rejects.toThrow(/check constraint/);
  await db.exec('reset role');
  expect((await db.query('select * from zeus_private.policy_audit')).rows).toHaveLength(1);
});
it('applies a personal feed command once and returns the same confirmed result after a retry',async()=>{
  await db.exec('set role authenticated');
  const action={type:'update_feed_config',summary:'Plus de science',command:{more_topics:['science']}};
  const query='select zeus_execute_personal_command($1,$2,now(),false,true) value';
  const first=(await db.query<{value:unknown}>(query,['feed',action])).rows[0].value;
  expect((await db.query<{value:unknown}>(query,['feed',action])).rows[0].value).toEqual(first);
  await db.exec('reset role');
  expect((await db.query('select * from test_feed_changes')).rows).toHaveLength(1);
});
it('rechecks that an accepted request belongs to the actor and recovers a lost response without accepting twice',async()=>{
  const id='33333333-3333-4333-8333-333333333333';
  await db.query("insert into friendships(id,requester_id,addressee_id,status) values($1,$2,$3,'pending')",[id,other,owner]);
  await db.exec('set role authenticated');
  const action={type:'respond_friend_request',friendship_id:id,decision:'accept'};
  const first=(await db.query<{value:unknown}>('select zeus_execute_personal_command($1,$2,now(),false,true) value',['friend',action])).rows[0].value;
  expect((await db.query<{value:unknown}>('select zeus_execute_personal_command($1,$2,now(),false,true) value',['friend',action])).rows[0].value).toEqual(first);
  await db.exec('reset role');expect((await db.query("select * from notifications where type='friend_accepted'")).rows).toHaveLength(1);await db.exec('set role authenticated');
  await db.query("select set_config('test.uid',$1,false)",[other]);
  await expect(db.query<{value:unknown}>('select zeus_execute_personal_command($1,$2,now(),false,true)',['foreign',action])).rejects.toThrow(/NOT_PENDING/);
});
it('consumes a publication reservation only once and only for the matching content',async()=>{
  await db.exec('set role authenticated');await claim('post','posts.publish');
  const dispatch='select zeus_dispatch_post_command($1,$2) value';
  expect((await db.query<{value:boolean}>(dispatch,['post','b'.repeat(64)])).rows[0].value).toBe(false);
  expect((await db.query<{value:boolean}>(dispatch,['post',fingerprint])).rows[0].value).toBe(true);
  expect((await db.query<{value:boolean}>(dispatch,['post',fingerprint])).rows[0].value).toBe(false);
});
it('permits a legitimately authorized paid account while keeping expiry checks',async()=>{
  await db.exec("update zeus_private.capability_policies set paid_only=true,required_role='admin' where capability='messages.send'");
  await db.query("select set_config('test.admin',$1,false)",[owner]);
  await db.query("insert into creator_subscriptions values($1,'active','creator_pro','synthetic-subscription',now()+interval '1 day')",[owner]);
  await db.exec('set role authenticated');expect((await claim('paid')).claimed).toBe(true);
  await db.exec("reset role;update creator_subscriptions set current_period_end=now()-interval '1 day';set role authenticated");
  await expect(claim('expired-subscription')).rejects.toThrow(/CAPABILITY_DENIED/);
});
it('bounds new command reservations without preventing a safe replay lookup',async()=>{
  await db.query("insert into zeus_private.command_receipts(user_id,command_key,capability,fingerprint,prepared_at) select $1,'bound-'||n,'messages.send',$2,now() from generate_series(1,60) n",[owner,fingerprint]);
  await db.exec('set role authenticated');
  expect((await claim('bound-1')).claimed).toBe(false);
  await expect(claim('over-limit')).rejects.toThrow(/RATE_LIMIT/);
});
it('exposes no Zeus RPC to anonymous callers and keeps the server catalog in sync with the registry',async()=>{
  const exposed=await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'zeus_%' and has_function_privilege('anon',p.oid,'execute')`);
  expect(exposed.rows).toEqual([]);
  const {ZEUS_CAPABILITY_IDS}=await import('@/lib/zeusCapabilities');
  const catalog=await db.query<{capability:string}>('select capability from zeus_private.capability_policies order by capability');
  expect(catalog.rows.map(row=>row.capability)).toEqual([...ZEUS_CAPABILITY_IDS].sort());
});
it('keeps the existing canonical friend-capacity protection on the Zeus path',async()=>{
  const id='33333333-3333-4333-8333-333333333333';
  await db.exec(`alter table friendships disable trigger enforce_friendship_capacity;
    insert into friendships(requester_id,addressee_id,status) select gen_random_uuid(),'${owner}','accepted' from generate_series(1,5000);
    alter table friendships enable trigger enforce_friendship_capacity;`);
  await db.query("insert into friendships(id,requester_id,addressee_id,status) values($1,$2,$3,'pending')",[id,other,owner]);
  await db.exec('set role authenticated');
  await expect(db.query('select zeus_execute_personal_command($1,$2,now(),false,true)',['capacity',{type:'respond_friend_request',friendship_id:id,decision:'accept'}])).rejects.toThrow(/FRIEND_LIMIT_REACHED/);
});
it('responds only to a pending request addressed to the authenticated account',async()=>{
  const mine='33333333-3333-4333-8333-333333333333',notMine='44444444-4444-4444-8444-444444444444';
  await db.query(`insert into friendships(id,requester_id,addressee_id,status) values
    ($1,$2,$3,'pending'),($4,$3,$2,'pending')`,[mine,other,owner,notMine]);
  await db.exec('set role authenticated');
  const result=(await db.query<{value:{decision:string}}>('select zeus_respond_friend_request($1,true) value',[mine])).rows[0].value;
  expect(result.decision).toBe('accepted');
  await expect(db.query('select zeus_respond_friend_request($1,true)',[mine])).rejects.toThrow(/NOT_PENDING/);
  await expect(db.query('select zeus_respond_friend_request($1,true)',[notMine])).rejects.toThrow(/NOT_PENDING/);
});
it('finds accented contacts without exposing other profile columns or choosing a homonym',async()=>{
  await db.query(`insert into profiles values($1,'Nadège Loynet',null),($2,'Nadège Dupont',null) on conflict(user_id) do update set name=excluded.name`,[owner,other]);
  await db.exec('set role authenticated');
  const rows=(await db.query('select * from zeus_find_contacts($1)',['nadege'])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({user_id:other,name:'Nadège Dupont'});
});
it('removes command receipts with the profile through the canonical account deletion chain',async()=>{
  await db.exec('set role authenticated');
  await claim('profile-cleanup');
  await db.exec('reset role');
  await db.query('delete from profiles where user_id=$1',[owner]);
  expect((await db.query('select * from zeus_private.command_receipts where user_id=$1',[owner])).rows).toHaveLength(0);
});
