// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {buildMerkleTree,leafHash} from '@/lib/crypto/ktMerkle';
let db:PGlite;
const key='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select '${key}'::uuid$$;
    grant usage on schema auth to authenticated;
  `);
  await db.exec(readFileSync('supabase/migrations/20260507132152_172753fa-e95a-4a81-8a06-8772fdcfa333.sql','utf8'));
  await db.exec('grant all on all tables in schema public to authenticated,service_role;grant usage on all sequences in schema public to authenticated,service_role;');
  await db.exec(readFileSync('supabase/migrations/20261018214314_atomic_transparency_epoch_publication.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate e2ee_kt_leaves,e2ee_kt_tree_heads,e2ee_transparency_log,e2ee_kt_signing_keys;
    insert into e2ee_kt_signing_keys(id,public_key_jwk)values('${key}','{}');
    insert into e2ee_transparency_log(id,user_id,event_type)values(1,'${key}','device_linked'),(2,'${key}','device_linked'),(3,'${key}','device_linked');
    select setval('e2ee_transparency_log_id_seq',4,false);
    set role service_role;`);
});
afterAll(async()=>{await db?.close()});
const leaves=async(ids=[1,2,3])=>Promise.all(ids.map(async id=>({id:String(id),hash:await leafHash('synthetic-'+id)})));
async function publish(items:Awaited<ReturnType<typeof leaves>>,epoch=1,previous:number|null=null,root?:string){
  return db.query('select publish_transparency_epoch($1,$2,$3,$4,$5,$6) as committed',[
    epoch,previous,root??(await buildMerkleTree(items.map(l=>l.hash))).root,key,'ab'.repeat(64),JSON.stringify(items),
  ]);
}
it('rejects browser changes to inclusion, signatures and protected log columns',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await expect(publish(await leaves())).rejects.toThrow(/permission denied/);
    await expect(db.query('update e2ee_kt_tree_heads set signature=$1',['ab'])).rejects.toThrow(/permission denied/);
  }
  await expect(db.query("insert into e2ee_transparency_log(user_id,event_type,included_in_epoch)values($1,'forged',1)",[key])).rejects.toThrow(/permission denied/);
  await db.query("insert into e2ee_transparency_log(user_id,event_type)values($1,'device_linked')",[key]);
});
it('matches the existing odd-leaf Merkle root and commits all three relations together',async()=>{
  expect((await publish(await leaves())).rows[0]).toEqual({committed:true});
  expect((await db.query('select leaf_index from e2ee_kt_leaves order by leaf_index')).rows).toEqual([{leaf_index:0},{leaf_index:1},{leaf_index:2}]);
  expect((await db.query('select included_in_epoch from e2ee_transparency_log order by id')).rows).toEqual(new Array(3).fill({included_in_epoch:1}));
});
it('refuses an inconsistent root without leaving a head, leaf or annotation',async()=>{
  await expect(publish(await leaves(),1,null,'ff'.repeat(32))).rejects.toThrow('KT_ROOT_MISMATCH');
  expect((await db.query('select * from e2ee_kt_tree_heads')).rows).toHaveLength(0);
  expect((await db.query('select * from e2ee_kt_leaves')).rows).toHaveLength(0);
  expect((await db.query('select id from e2ee_transparency_log where included_in_epoch is not null')).rows).toHaveLength(0);
});
it('rejects duplicate/missing rows and conflicting publishers instead of publishing partially',async()=>{
  const items=await leaves();
  await expect(publish([items[0],items[0]])).rejects.toThrow('KT_DUPLICATE_LEAF');
  await expect(publish(await leaves([99]))).rejects.toThrow('KT_LOG_MISSING');
  await publish(items);
  await expect(publish(items)).rejects.toThrow('KT_EPOCH_RACE');
  await expect(publish(items,2,1)).rejects.toThrow('KT_LOG_ALREADY_PUBLISHED');
  expect((await db.query('select * from e2ee_kt_tree_heads')).rows).toHaveLength(1);
});
it('rolls back the head if a later leaf write fails',async()=>{
  await db.exec(`reset role;create function fail_leaf()returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_WRITE_FAILURE';end$$;
    create trigger fail_leaf before insert on e2ee_kt_leaves for each row execute function fail_leaf();set role service_role;`);
  await expect(publish(await leaves())).rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
  expect((await db.query('select * from e2ee_kt_tree_heads')).rows).toHaveLength(0);
  expect((await db.query('select id from e2ee_transparency_log where included_in_epoch is not null')).rows).toHaveLength(0);
  await db.exec('reset role;drop trigger fail_leaf on e2ee_kt_leaves;drop function fail_leaf();');
});
