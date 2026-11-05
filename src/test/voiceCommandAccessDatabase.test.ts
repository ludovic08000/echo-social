// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
    create table creator_subscriptions(user_id uuid,status text,plan text,stripe_subscription_id text,current_period_end timestamptz);
    alter table creator_subscriptions enable row level security;
    grant select on creator_subscriptions to authenticated;
    create policy own_subscription on creator_subscriptions for select to authenticated using(user_id=auth.uid());`);
  await db.exec(readFileSync('supabase/migrations/20261105172310_voice_command_grants.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate voice_command_grants,creator_subscriptions;select set_config('test.uid','${owner}',false);`);
});
afterAll(async()=>db?.close());
async function allowed(){return (await db.query<{allowed:boolean}>('select voice_command_access() as allowed')).rows[0].allowed;}
describe('server-owned voice command permissions',()=>{
  it('grants voice only to the selected account without changing billing or roles',async()=>{
    await db.query('insert into voice_command_grants(user_id) values($1)',[owner]);
    await db.exec('set role authenticated');expect(await allowed()).toBe(true);
    expect((await db.query('select * from creator_subscriptions')).rows).toHaveLength(0);
    await db.query(`select set_config('test.uid',$1,false)`,[other]);expect(await allowed()).toBe(false);
    expect((await db.query('select * from voice_command_grants')).rows).toHaveLength(0);
  });
  it('does not let an ordinary account grant, extend or revoke access',async()=>{
    await db.query('insert into voice_command_grants(user_id) values($1)',[owner]);
    await db.exec('set role authenticated');
    await expect(db.query('insert into voice_command_grants(user_id) values($1)',[other])).rejects.toThrow(/permission denied/);
    await expect(db.query('update voice_command_grants set expires_at=null')).rejects.toThrow(/permission denied/);
    await expect(db.query('delete from voice_command_grants')).rejects.toThrow(/permission denied/);
  });
  it.each(['expires_at','revoked_at'])('rejects an expired or revoked grant (%s)',async column=>{
    await db.query(`insert into voice_command_grants(user_id,${column}) values($1,now()-interval '1 day')`,[owner]);
    await db.exec('set role authenticated');expect(await allowed()).toBe(false);
  });
  it('preserves paid creator voice access for all other accounts',async()=>{
    await db.query(`insert into creator_subscriptions values($1,'active','creator_pro','sub_verified',now()+interval '1 day')`,[owner]);
    await db.exec('set role authenticated');expect(await allowed()).toBe(true);
  });
  it('denies an unsigned visitor and an ordinary non-creator',async()=>{
    await db.exec('set role authenticated');expect(await allowed()).toBe(false);
    await db.exec('set role anon');await expect(allowed()).rejects.toThrow(/permission denied/);
  });
});
