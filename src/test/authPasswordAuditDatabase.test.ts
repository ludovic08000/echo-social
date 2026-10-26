// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
let db:PGlite;
const uid='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create role supabase_auth_admin;
    create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${uid}');
    grant usage on schema auth to supabase_auth_admin;grant select on auth.users to supabase_auth_admin;
    create schema aegis_observability;
    create table aegis_observability.journey_events(id bigint generated always as identity primary key,occurred_at timestamptz default clock_timestamp(),
      user_id uuid references auth.users(id),session_id uuid,device_ref text,message_id uuid,stage text,outcome text,source text,evidence text,error_code text,request_id uuid);
    alter table aegis_observability.journey_events enable row level security;
  `);
  await db.exec(readFileSync('supabase/migrations/20261018214411_auth_verified_password_attempt_audit.sql','utf8'));
},30000);
beforeEach(async()=>{await db.exec('reset role;truncate aegis_observability.journey_events;set role supabase_auth_admin')});
afterAll(async()=>{await db?.close()});
const send=(event:unknown)=>db.query<{r:{decision:string}}>('select hook_password_verification_audit($1) as r',[JSON.stringify(event)]);
it('only permits the native Auth role, not browser or service declarations',async()=>{
  for(const role of ['anon','authenticated','service_role']){
    await db.exec(`set role ${role}`);await expect(send({user_id:uid,valid:false})).rejects.toThrow(/permission denied/);
  }
});
it('records an authoritative password outcome without storing arbitrary inputs or approving an account/device',async()=>{
  expect((await send({user_id:uid,valid:false,password:'SECRET',email:'SECRET',ip_address:'SECRET',device_id:'SECRET'})).rows[0].r.decision).toBe('continue');
  await db.exec('reset role');
  const events=(await db.query('select * from aegis_observability.journey_events')).rows;
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({stage:'auth_password_rejected',evidence:'server',outcome:'failure',session_id:null});
  expect(JSON.stringify(events)).not.toContain('SECRET');
});
it('does not let failures from an attacker reject a later correct password or log out the victim',async()=>{
  for(let i=0;i<125;i++)await send({user_id:uid,valid:false});
  expect((await send({user_id:uid,valid:true})).rows[0].r).toEqual({decision:'continue'});
  await db.exec('reset role');
  expect((await db.query('select * from aegis_observability.journey_events')).rows).toHaveLength(121);
});
it('keeps Auth behavior intact on malformed payloads, unknown users or an unavailable audit store',async()=>{
  for(const event of [{user_id:uid,valid:'true'},{user_id:'bad',valid:false},{user_id:uid.replace(/1$/,'9'),valid:false}]){
    expect((await send(event)).rows[0].r).toEqual({decision:'continue'});
  }
  await db.exec('reset role;alter table aegis_observability.journey_events rename to unavailable;set role supabase_auth_admin');
  expect((await send({user_id:uid,valid:true})).rows[0].r).toEqual({decision:'continue'});
  await db.exec('reset role;alter table aegis_observability.unavailable rename to journey_events');
});
