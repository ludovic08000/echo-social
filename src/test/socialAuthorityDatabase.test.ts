// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
let db:PGlite;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const asUser=async(n:number)=>{await db.exec('reset role');await db.query("select set_config('test.uid',$1,false)",[id(n)]);await db.exec('set role authenticated')};
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon,service_role;
    create function has_role(uuid,text) returns boolean language sql stable as $$select $1='00000000-0000-4000-8000-000000000003'::uuid and $2='admin'$$;
    create function assert_current_login_session_approved() returns void language plpgsql as $$begin
      if current_setting('test.approved',true)='false' then raise exception 'SESSION_NOT_APPROVED' using errcode='42501';end if;end$$;
    create type friendship_status as enum('pending','accepted','rejected');
    create table friendships(id uuid primary key default gen_random_uuid(),requester_id uuid,addressee_id uuid,status friendship_status default 'pending',created_at timestamptz default now());
    alter table friendships enable row level security;
    create policy read_related on friendships for select to authenticated using(auth.uid() in(requester_id,addressee_id));
    create policy delete_related on friendships for delete to authenticated using(auth.uid() in(requester_id,addressee_id));
    create policy old_insert on friendships for insert with check(requester_id=auth.uid());
    create policy old_update on friendships for update using(auth.uid() in(requester_id,addressee_id));
    create table ai_moderation_cache(result jsonb);create table ai_learned_rules(rule text);create table ai_agent_usage(message_count integer);
    create table ads(id int primary key,headline text,primary_text text,image_url text,video_url text,cta_url text,moderation_status text default 'pending',moderation_reason text);
    create table conversations(id uuid primary key,is_group boolean default false);
    create table conversation_participants(conversation_id uuid,user_id uuid);
    create table messages(id uuid primary key,conversation_id uuid,sender_id uuid,status text);
    create table user_message_blocks(blocker_user_id uuid,blocked_user_id uuid);
    grant all on all tables in schema public to authenticated,service_role;
  `);
  await db.exec(readFileSync('supabase/migrations/20261018203440_secure_social_and_privileged_authority.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate friendships,ads,conversations,conversation_participants,messages,user_message_blocks;
    select set_config('test.approved','true',false);
    insert into conversations values('${id(10)}',false);
    insert into conversation_participants values('${id(10)}','${id(1)}'),('${id(10)}','${id(2)}');
    insert into messages values('${id(11)}','${id(10)}','${id(1)}','pending');
    insert into ads(id,headline,moderation_status) values(1,'original','approved');`);
  await asUser(1);
});
afterAll(async()=>{await db?.close()});
it('refuses inserting an already accepted friendship',async()=>{
  await expect(db.query('insert into friendships(requester_id,addressee_id,status)values($1,$2,\'accepted\')',[id(1),id(2)])).rejects.toThrow(/row-level security/);
});
it('only the recipient can accept, and either user can later unfriend',async()=>{
  await db.query('insert into friendships(id,requester_id,addressee_id)values($1,$2,$3)',[id(5),id(1),id(2)]);
  expect((await db.query("update friendships set status='accepted' returning id")).rows).toHaveLength(0);
  await asUser(2);
  expect((await db.query("update friendships set status='accepted' returning id")).rows).toHaveLength(1);
  await asUser(1);
  expect((await db.query('delete from friendships returning id')).rows).toHaveLength(1);
});
it('cannot reassign the two identities while accepting',async()=>{
  await db.query('insert into friendships(requester_id,addressee_id)values($1,$2)',[id(1),id(2)]);await asUser(2);
  await expect(db.query("update friendships set requester_id=$1,status='accepted'",[id(3)])).rejects.toThrow('FRIENDSHIP_IDENTITY_IMMUTABLE');
});
it('does not let a client write moderation decisions or usage counters',async()=>{
  await expect(db.query("insert into ai_moderation_cache values('{}')")).rejects.toThrow(/permission denied/);
  await expect(db.query("insert into ai_learned_rules values('invented')")).rejects.toThrow(/permission denied/);
  await expect(db.query('delete from ai_agent_usage')).rejects.toThrow(/permission denied/);
});
it('protects ad approvals and sends an edited creative back for review',async()=>{
  await expect(db.query("update ads set moderation_status='rejected' where id=1")).rejects.toThrow('AD_MODERATION_SERVER_ONLY');
  await expect(db.query("insert into ads(id,moderation_status)values(2,'approved')")).rejects.toThrow('AD_MODERATION_SERVER_ONLY');
  await db.query("update ads set headline='changed' where id=1");
  expect((await db.query('select moderation_status from ads')).rows[0]).toEqual({moderation_status:'pending'});
});
it('preserves an administrator approval of a reviewed creative',async()=>{
  await asUser(3);await db.query("update ads set moderation_status='approved',moderation_reason='reviewed' where id=1");
  expect((await db.query('select moderation_status from ads')).rows[0]).toEqual({moderation_status:'approved'});
});
it('refuses the sender accepting their own request and third-party decisions',async()=>{
  await expect(db.query('select decide_direct_message_request($1,true)',[id(10)])).rejects.toThrow('NO_INCOMING_REQUEST');
  await asUser(3);await expect(db.query('select decide_direct_message_request($1,true)',[id(10)])).rejects.toThrow('FORBIDDEN');
});
it('lets the exact recipient accept only messages from the peer',async()=>{
  await db.exec('reset role');await db.query('insert into messages values($1,$2,$3,$4)',[id(12),id(10),id(2),'pending']);await asUser(2);
  expect((await db.query('select decide_direct_message_request($1,true) as n',[id(10)])).rows[0]).toEqual({n:1});
  expect((await db.query('select status from messages where id=$1',[id(12)])).rows[0]).toEqual({status:'pending'});
  expect((await db.query('select status from messages where id=$1',[id(11)])).rows[0]).toEqual({status:'delivered'});
});
it('refuses group, unapproved session and blocked-peer request decisions',async()=>{
  await asUser(2);await db.exec("select set_config('test.approved','false',false)");
  await expect(db.query('select decide_direct_message_request($1,true)',[id(10)])).rejects.toThrow('SESSION_NOT_APPROVED');
  await db.exec("select set_config('test.approved','true',false);reset role");
  await db.query('update conversations set is_group=true');await asUser(2);
  await expect(db.query('select decide_direct_message_request($1,true)',[id(10)])).rejects.toThrow('DIRECT_CONVERSATION_REQUIRED');
  await db.exec('reset role;update conversations set is_group=false');
  await db.query('insert into user_message_blocks values($1,$2)',[id(1),id(2)]);await asUser(2);
  await expect(db.query('select decide_direct_message_request($1,true)',[id(10)])).rejects.toThrow('FORBIDDEN');
});
