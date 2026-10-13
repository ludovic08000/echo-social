// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
let db: PGlite;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    create function assert_current_login_session_approved() returns void language plpgsql as $$begin
      if current_setting('test.approved',true)<>'true' then raise exception 'LOGIN_SECURITY_APPROVAL_REQUIRED'; end if; end$$;
    create table conversations(id uuid primary key,disappearing_seconds integer,created_at timestamptz default now(),
      updated_at timestamptz default now(),is_group boolean default false,name text,created_by uuid);
    create table conversation_participants(conversation_id uuid,user_id uuid,last_read_at timestamptz,joined_at timestamptz default now());
    create table profiles(user_id uuid,name text,avatar_url text);
    create table user_devices(user_id uuid,device_id text,last_seen_at timestamptz,updated_at timestamptz,revoked_at timestamptz);
    create table messages(id uuid primary key,conversation_id uuid,sender_id uuid,body_kind text,
      view_once boolean default false,expires_at timestamptz,body text,archive_body text,created_at timestamptz default now(),
      status text default 'delivered',image_url text,document_url text,document_name text,document_mime text,document_size_bytes integer);
    create table message_recipient_states(message_id uuid references messages on delete cascade,
      conversation_id uuid,sender_user_id uuid,recipient_user_id uuid,state text,read_at timestamptz,
      delivered_at timestamptz,updated_at timestamptz);
    create table message_archives(message_id uuid references messages on delete cascade,user_id uuid,archive_body text);
    create table message_device_copies(id uuid primary key,message_id uuid references messages on delete cascade,
      delivered_at timestamptz,read_at timestamptz,encrypted_body text,sender_user_id uuid,sender_device_id text,
      recipient_user_id uuid,recipient_device_id text,created_at timestamptz default now());
    create table aegis_device_inbox(copy_id uuid references message_device_copies on delete cascade,
      message_id uuid references messages on delete cascade,recipient_user_id uuid,recipient_device_id text,
      state text,acked_at timestamptz,read_at timestamptz,expires_at timestamptz,
      available_at timestamptz default now(),last_synced_at timestamptz,sync_attempt_count integer default 0);
    create table message_read_receipts(message_id uuid,conversation_id uuid,user_id uuid,device_id text,
      read_at timestamptz,unique(message_id,user_id,device_id));
    create function get_sesame_device_list(uuid) returns table(device_id text,is_routable boolean)
      language sql as $$select 'approved-device'::text,true$$;
    create function set_message_expires_at() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger trg_set_message_expires_at before insert on messages for each row execute function set_message_expires_at();
    create function log_disappearing_change() returns trigger language plpgsql as $$begin raise exception 'OLD_PLAINTEXT_AUDIT'; end$$;
    alter table messages enable row level security; alter table message_archives enable row level security;
    alter table message_device_copies enable row level security;
    create policy visible on messages for select to authenticated using(exists(select 1 from conversation_participants where conversation_id=messages.conversation_id and user_id=auth.uid()));
    create policy visible on message_archives for select to authenticated using(user_id=auth.uid());
    create policy visible on message_device_copies for select to authenticated using(true);
    grant select on conversations,conversation_participants,messages,message_archives,message_device_copies to authenticated;
  `);
  const ack=readFileSync('supabase/migrations/20260927210000_explicit_message_blocks_and_read_receipts.sql','utf8');
  await db.exec(ack.slice(ack.indexOf('create or replace function public.aegis_ack_device_messages('),ack.indexOf('-- A fully blocked view-once send')));
  const previewStart=ack.indexOf('create or replace function public.get_conversations_with_details(');
  await db.exec(ack.slice(previewStart,ack.indexOf('$function$;',previewStart)+'$function$;'.length));
  const inbox=readFileSync('supabase/migrations/20260804154000_aegis_durable_database.sql','utf8');
  await db.exec(inbox.slice(inbox.indexOf('create or replace function public.aegis_sync_device('),inbox.indexOf('create or replace function public.aegis_ack_device_messages(')));
  await db.exec(readFileSync('supabase/migrations/20261013142629_message_retention_after_read.sql','utf8'));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`reset role; truncate conversations,conversation_participants,messages,message_expiration_tombstones,auth.users cascade;
    insert into auth.users values('${id(1)}'),('${id(2)}'),('${id(3)}');
    insert into conversations(id) values('${id(10)}');
    insert into conversation_participants(conversation_id,user_id) values('${id(10)}','${id(1)}'),('${id(10)}','${id(2)}');
    select set_config('test.uid','${id(1)}',false),set_config('test.approved','true',false);`);
});
async function policy(seconds:number|null){
  await db.exec('set role authenticated');
  const result=await db.query('select set_conversation_retention($1,$2) as result',[id(10),seconds]);
  await db.exec('reset role'); return result.rows[0];
}
async function send(){
  await db.query(`insert into messages(id,conversation_id,sender_id,body_kind,body,archive_body)
    values($1,$2,$3,'multi_device','opaque','opaque-archive')`,[id(20),id(10),id(1)]);
  await db.query(`insert into message_recipient_states(message_id,conversation_id,sender_user_id,recipient_user_id,state)
    values($1,$2,$3,$4,'sent')`,[id(20),id(10),id(1),id(2)]);
  await db.exec(`insert into message_device_copies(id,message_id,sender_user_id,sender_device_id,recipient_user_id,recipient_device_id,encrypted_body)
    values('${id(30)}','${id(20)}','${id(1)}','sender-device','${id(2)}','approved-device','cipher');
    insert into aegis_device_inbox(copy_id,message_id,recipient_user_id,recipient_device_id,state,expires_at)
    values('${id(30)}','${id(20)}','${id(2)}','approved-device','pending',now()+interval '90 days');
    insert into message_archives values('${id(20)}','${id(1)}','encrypted');`);
}
async function ack(read:boolean,device='approved-device'){
  await db.exec(`select set_config('test.uid','${id(2)}',false);set role authenticated;`);
  return db.query('select aegis_ack_device_messages($1,$2,$3)',[device,[id(20)],read]);
}
it.each([0,86400,604800,null])('persists %s only for future messages without plaintext audit',async(seconds)=>{
  await policy(seconds); await send();
  const row=(await db.query('select retention_after_read_seconds,expires_at from messages')).rows[0];
  expect(row).toEqual({retention_after_read_seconds:seconds,expires_at:null});
});
it('delivery ACK does not start the timer',async()=>{
  await policy(86400);await send();await ack(false);await db.exec('reset role');
  expect((await db.query('select retention_started_at from messages')).rows[0]).toEqual({retention_started_at:null});
});
it.each([86400,604800])('read ACK starts %s seconds once, never extends on retry',async(seconds)=>{
  await policy(seconds);await send();await ack(true);await db.exec('reset role');
  const first=(await db.query<{expires_at:Date;seconds:number}>('select expires_at,extract(epoch from expires_at-retention_started_at)::int as seconds from messages')).rows[0];
  expect(first.seconds).toBe(seconds);await ack(true);await db.exec('reset role');
  expect((await db.query<{expires_at:Date}>('select expires_at from messages')).rows[0].expires_at).toEqual(first.expires_at);
});
it('immediate expiry completes ACK then removes message, capsules and archives with tombstones',async()=>{
  await policy(0);await send();await ack(true);await db.exec('reset role');
  expect((await db.query<{count:number}>('select count(*)::int as count from messages')).rows[0].count).toBe(0);
  for(const table of ['message_device_copies','message_archives','aegis_device_inbox'])
    expect((await db.query<{count:number}>(`select count(*)::int as count from ${table}`)).rows[0].count).toBe(0);
  expect((await db.query<{count:number}>('select count(*)::int as count from message_expiration_tombstones')).rows[0].count).toBe(2);
  // Une réponse d'envoi perdue suivie d'un retry ne recrée pas le message effacé.
  await expect(send()).rejects.toThrow('MESSAGE_EXPIRED_IRREVERSIBLE');
});
it('never does not expire even after read',async()=>{
  await policy(null);await send();await ack(true);await db.exec('reset role');
  expect((await db.query<{expires_at:Date|null}>('select expires_at from messages')).rows[0].expires_at).toBeNull();
});
it('changing policy does not change existing message snapshot',async()=>{
  await policy(86400);await send();await policy(0);
  expect((await db.query<{retention_after_read_seconds:number}>('select retention_after_read_seconds from messages')).rows[0].retention_after_read_seconds).toBe(86400);
});
it('rejects nonparticipants, unapproved sessions, unsupported duration and unauthorized devices',async()=>{
  await expect(policy(123)).rejects.toThrow('RETENTION_DURATION_INVALID');await db.exec('reset role');
  await db.exec(`select set_config('test.uid','${id(3)}',false)`);
  await expect(policy(0)).rejects.toThrow('CONVERSATION_NOT_AUTHORIZED');await db.exec('reset role');
  await db.exec(`select set_config('test.uid','${id(1)}',false),set_config('test.approved','false',false)`);
  await expect(policy(0)).rejects.toThrow('LOGIN_SECURITY_APPROVAL_REQUIRED');await db.exec('reset role');
  await db.exec("select set_config('test.approved','true',false)");await policy(0);await send();
  await expect(ack(true,'attacker-device')).rejects.toThrow('E2EE_DEVICE_NOT_AUTHORIZED');
});
it('hides expired messages and archives before cron, then physically purges them',async()=>{
  await policy(86400);await send();await ack(true);await db.exec('reset role');
  await db.exec(`select set_config('test.uid','${id(1)}',false)`);
  expect((await db.query('select * from get_conversations_with_details($1)',[id(1)])).rows).toHaveLength(1);
  await db.exec("update aegis_device_inbox set state='pending',acked_at=null,read_at=null");
  await db.exec(`select set_config('test.uid','${id(2)}',false);set role authenticated`);
  expect((await db.query("select * from aegis_sync_device('approved-device',100)")).rows).toHaveLength(1);
  await db.exec('reset role');
  await db.exec("update messages set expires_at=now()-interval '1 second'");
  await db.exec(`select set_config('test.uid','${id(2)}',false);set role authenticated`);
  expect((await db.query("select aegis_sync_device('approved-device',100)")).rows).toEqual([]);
  await db.exec('reset role');
  await db.exec(`select set_config('test.uid','${id(1)}',false);set role authenticated`);
  expect((await db.query('select * from messages')).rows).toEqual([]);
  const previews=await db.query<{last_message_body:string|null}>('select * from get_conversations_with_details($1)',[id(1)]);
  expect(previews.rows).toHaveLength(1); // La conversation reste, seul le message expire.
  expect(previews.rows[0].last_message_body).toBeNull();
  expect((await db.query('select * from message_archives')).rows).toEqual([]);
  await expect(db.exec('select aegis_retention.purge_expired()')).rejects.toThrow('permission denied');
  await db.exec('reset role');expect((await db.query<{count:number}>('select aegis_retention.purge_expired() as count')).rows[0].count).toBe(1);
});
it('waits for every unblocked group recipient and ignores sender device ACKs',async()=>{
  await policy(86400);await send();
  await db.exec(`insert into conversation_participants(conversation_id,user_id) values('${id(10)}','${id(3)}');
    insert into message_recipient_states(message_id,conversation_id,sender_user_id,recipient_user_id,state)
    values('${id(20)}','${id(10)}','${id(1)}','${id(3)}','sent');`);
  await ack(true);await db.exec('reset role');
  expect((await db.query<{expires_at:Date|null}>('select expires_at from messages')).rows[0].expires_at).toBeNull();
  await db.exec(`update message_recipient_states set state='read',read_at=now() where recipient_user_id='${id(3)}'`);
  expect((await db.query<{expires_at:Date|null}>('select expires_at from messages')).rows[0].expires_at).not.toBeNull();
});
it('never rewrites or purges historical messages when enabling the feature',async()=>{
  await send();await policy(0);await ack(true);await db.exec('reset role');
  expect((await db.query<{retention_after_read_seconds:number|null}>('select retention_after_read_seconds from messages')).rows[0].retention_after_read_seconds).toBeNull();
  expect((await db.query<{count:number}>('select aegis_retention.purge_expired() as count')).rows[0].count).toBe(0);
});
it('does not expose another account’s expiration records',async()=>{
  await policy(0);await send();await ack(true);await db.exec('reset role');
  await db.exec(`select set_config('test.uid','${id(3)}',false);set role authenticated`);
  expect((await db.query('select * from message_expiration_tombstones')).rows).toEqual([]);
  await expect(db.exec('delete from message_expiration_tombstones')).rejects.toThrow('permission denied');
});
it('rolls back safely before activation and refuses rollback after an explicit user choice',async()=>{
  const rollback=readFileSync('supabase/rollback/message_retention_before_activation.sql','utf8');
  await db.exec(rollback);
  await db.exec(readFileSync('supabase/migrations/20261013142629_message_retention_after_read.sql','utf8'));
  await policy(86400);
  await expect(db.exec(rollback)).rejects.toThrow('RETENTION_ALREADY_ACTIVE_ROLLBACK_REFUSED');
  await db.exec('rollback');
  expect((await db.query("select to_regclass('public.message_expiration_tombstones') as table_name")).rows[0]).toEqual({table_name:'message_expiration_tombstones'});
});
