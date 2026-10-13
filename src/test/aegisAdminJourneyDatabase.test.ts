// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db: PGlite;
async function asUser(n: number, session = 20) {
  await db.exec('reset role');
  await db.query("select set_config('test.uid',$1,false),set_config('test.session',$2,false)",[uid(n),uid(session)]);
  await db.exec('set role authenticated');
}
async function timeline(account?: string, before?: string) {
  const result = await db.query<{ events: Array<Record<string, unknown>> }>('select public.admin_aegis_journey($1,$2,null) as events',[account ?? null,before ?? null]);
  return result.rows[0].events;
}
describe('private Aegis admin timeline — actual migration in PostgreSQL', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; grant usage on schema auth,public to authenticated,anon;
      create table auth.users(id uuid primary key,email text);
      create table auth.sessions(id uuid primary key,user_id uuid);
      create type public.app_role as enum ('admin','user');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      create function public.current_login_security_session_id() returns uuid language sql stable as $$select nullif(current_setting('test.session',true),'')::uuid$$;
      create function public.has_role(uuid,public.app_role) returns boolean language sql stable as $$select $1 = '${uid(1)}'::uuid and $2 = 'admin'$$;
      create table public.user_devices(user_id uuid,device_id text,approval_status text,binding_status text,routing_status text,is_active boolean,revoked_at timestamptz,last_seen_at timestamptz,device_public_key text);
      create table public.device_enrollment_challenges(user_id uuid,device_id text,consumed_at timestamptz,cancelled_at timestamptz,nonce_hash text);
      create table public.login_security_events(user_id uuid,session_id uuid,event_type text,outcome text,detail jsonb);
      create table public.login_security_sessions(user_id uuid,session_id uuid);
      create table public.email_send_log(message_id text,template_name text,status text,recipient_email text,error_message text);
      create table public.messages(id uuid,sender_id uuid,body text);
      create table public.crypto_error_logs(user_id uuid,my_device_id text,error_code text,error_message text,metadata jsonb);
      insert into auth.users values ('${uid(1)}','admin@example.test'),('${uid(2)}','client@example.test');
      insert into auth.sessions values ('${uid(20)}','${uid(1)}');
      insert into public.login_security_sessions values ('${uid(2)}','${uid(22)}');
    `);
    await db.exec(readFileSync('supabase/migrations/20261013124657_aegis_admin_journey.sql','utf8'));
  });
  afterAll(async () => { await db?.close(); });
  it('denies non-admin, anonymous, revoked session and direct table access', async () => {
    await asUser(2); await expect(timeline()).rejects.toThrow('ADMIN_REQUIRED');
    await expect(db.query('select * from aegis_observability.journey_events')).rejects.toThrow('permission denied');
    await asUser(1,99); await expect(timeline()).rejects.toThrow('ADMIN_REQUIRED');
    await db.exec('reset role;set role anon');
    await expect(timeline()).rejects.toThrow('permission denied');
  });
  it('captures real enrollment, email approval, route and message without secrets', async () => {
    await db.exec('reset role');
    await db.query(`insert into public.email_send_log values ($1,'login_security_approval','sent','SECRET_EMAIL','SECRET_ERROR')`,[`login-security:${uid(22)}:abcdef1234567890`]);
    await db.query(`insert into public.login_security_events values($1,$2,'login_decision','success','{"decision":"approve","token":"SECRET_TOKEN"}')`,[uid(2),uid(22)]);
    await db.query(`insert into public.device_enrollment_challenges values($1,'SECRET_DEVICE',null,null,'SECRET_NONCE')`,[uid(2)]);
    await db.query(`insert into public.user_devices values($1,'SECRET_DEVICE','pending','unbound','repairing',true,null,now(),'SECRET_KEY')`,[uid(2)]);
    await db.query(`update public.user_devices set approval_status='approved' where user_id=$1`,[uid(2)]);
    await db.query(`update public.user_devices set binding_status='bound' where user_id=$1`,[uid(2)]);
    await db.query(`update public.user_devices set routing_status='ready' where user_id=$1`,[uid(2)]);
    await db.query(`insert into public.messages values($1,$2,'SECRET_CONTENT')`,[uid(80),uid(2)]);
    await asUser(1);
    const events = await timeline('client@example.test');
    expect(events.map(e => e.stage)).toEqual(expect.arrayContaining(['approval_email_provider_accepted','login_approved','device_enrollment_started','device_registered','device_approved','device_bound','device_route_ready','message_stored']));
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(events.find(e => e.stage === 'login_approved')?.session_id).toBe(uid(22));
    expect(await timeline('missing@example.test')).toEqual([]);
    expect(events.map(e => e.occurred_at)).toEqual(events.map(e => e.occurred_at).sort().reverse());
  });
  it('does not log heartbeat updates; client errors are explicitly untrusted and sanitized', async () => {
    await asUser(1); const count = (await timeline()).length;
    await db.exec('reset role');
    await db.exec('update public.user_devices set last_seen_at=now()');
    await db.query(`insert into public.crypto_error_logs values($1,'SECRET_DEVICE','SECRET_CODE','SECRET_MESSAGE',null)`,[uid(2)]);
    await asUser(1); const events = await timeline();
    expect(events.length).toBe(count+1);
    expect(events[0]).toMatchObject({evidence:'client_report',error_code:'UNCLASSIFIED_ERROR'});
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });
  it('pagination preserves numeric ID order for equal timestamps without duplicates', async () => {
    await db.exec('reset role');
    await db.exec(`insert into aegis_observability.journey_events(user_id,stage,outcome,source,evidence,occurred_at)
      select '${uid(2)}','test','info','test','server',now() from generate_series(1,115)`);
    await asUser(1);
    const page1 = await timeline(); const page2 = await timeline(undefined,String(page1.at(-1)?.id));
    expect(page1).toHaveLength(100); expect(page2.length).toBeGreaterThan(0);
    expect(new Set([...page1,...page2].map(e => e.id)).size).toBe(page1.length+page2.length);
  });
  it('audit storage failure never prevents a real message insert', async () => {
    await db.exec('reset role');
    await db.exec('alter table aegis_observability.journey_events rename to journey_unavailable');
    await expect(db.query('insert into public.messages values($1,$2,$3)',[uid(81),uid(2),'protected'])).resolves.toBeDefined();
    await db.exec('alter table aegis_observability.journey_unavailable rename to journey_events');
    const result = await db.query<{count:number}>('select count(*)::int as count from public.messages where id=$1',[uid(81)]);
    expect(result.rows[0].count).toBe(1);
  });
  it('transport reports cannot impersonate users, leak arbitrary errors or duplicate a request', async () => {
    await db.exec('reset role');
    await db.query('insert into auth.sessions values($1,$2)',[uid(23),uid(2)]);
    await asUser(2,23);
    await db.query('select public.record_aegis_request_event($1,$2,403,$3,12)',[uid(70),'aegis_send_message','SECRET']);
    await db.query('select public.record_aegis_request_event($1,$2,200,null,12)',[uid(70),'aegis_send_message']);
    await asUser(1);
    const events = (await timeline('client@example.test')).filter(e => e.request_id === uid(70));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({user_id:uid(2),session_id:uid(23),evidence:'transport_report',error_code:'UNCLASSIFIED_ERROR',duration_ms:12});
    await asUser(2,99);
    await db.query('select public.record_aegis_request_event($1,$2,200,null,12)',[uid(71),'aegis_send_message']);
    await asUser(1);
    expect((await timeline()).some(e => e.request_id === uid(71))).toBe(false);
  });
  it('rollback stops capture while retaining messages, device state and diagnostic history', async () => {
    await db.exec('reset role');
    const before = await db.query<{count:number}>('select count(*)::int as count from aegis_observability.journey_events');
    await db.exec(readFileSync('supabase/rollback/aegis_admin_journey.sql','utf8'));
    await db.query('insert into public.messages values($1,$2,$3)',[uid(82),uid(2),'unchanged encrypted path']);
    const after = await db.query<{count:number}>('select count(*)::int as count from aegis_observability.journey_events');
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect((await db.query('select * from public.user_devices')).rows).toHaveLength(1);
    await asUser(2,23);
    await expect(db.query('select public.record_aegis_request_event($1,$2,200,null,0)',[uid(83),'aegis_send_message'])).rejects.toThrow('permission denied');
  });
});
