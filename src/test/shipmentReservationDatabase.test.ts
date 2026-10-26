// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
let db:PGlite;
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create type order_status as enum('paid','processing','shipped','delivered','cancelled');
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table orders(id uuid primary key,status order_status,payment_verified_at timestamptz,tracking_number text,delivered_at timestamptz,
      shipping_label_url text,shipping_weight_grams integer,shipped_at timestamptz);
    create table seller_profiles(id uuid primary key,user_id uuid);
    create table order_items(order_id uuid,seller_id uuid,status order_status default 'paid');
    grant all on all tables in schema public to service_role;`);
  await db.exec(readFileSync('supabase/migrations/20261018212651_serialize_marketplace_shipment_creation.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate marketplace_shipment_claims,orders,order_items,seller_profiles;
    insert into orders(id,status,payment_verified_at)values('${uid(1)}','paid',now());
    insert into seller_profiles values('${uid(2)}','${uid(3)}');
    insert into order_items(order_id,seller_id) values('${uid(1)}','${uid(2)}');set role service_role;`);
});
afterAll(async()=>{await db?.close()});
const claim=(id=uid(10),caller=uid(3))=>db.query<{r:{claimed:boolean,tracking_number?:string}}>('select claim_marketplace_shipment($1,$2,$3) as r',[uid(1),caller,id]);
const complete=(id=uid(10),tracking='12345678')=>db.query<{r:boolean}>('select complete_marketplace_shipment($1,$2,$3,$4,$5) as r',[uid(1),id,tracking,'https://www.mondialrelay.fr/synthetic.pdf',500]);
it('only permits the server role to reserve or settle a shipment',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await expect(claim()).rejects.toThrow(/permission denied/);
    await expect(complete()).rejects.toThrow(/permission denied/);
    await expect(db.query('select * from marketplace_shipment_claims')).rejects.toThrow(/permission denied/);
  }
});
it('revalidates shop ownership and server-verified payment under the order lock',async()=>{
  await expect(claim(uid(10),uid(4))).rejects.toThrow('SHIPMENT_OWNER_REQUIRED');
  await db.query('update orders set payment_verified_at=null');
  await expect(claim()).rejects.toThrow('VERIFIED_PAYMENT_REQUIRED');
  expect((await db.query('select * from marketplace_shipment_claims')).rows).toHaveLength(0);
});
it('grants at most one concurrent carrier operation, without a timeout reopening it',async()=>{
  const results=await Promise.all(Array.from({length:8},(_,i)=>claim(uid(10+i))));
  expect(results.filter(x=>x.rows[0].r.claimed)).toHaveLength(1);
  await db.query("update marketplace_shipment_claims set created_at=now()-interval '10 days'");
  expect((await claim(uid(30))).rows[0].r.claimed).toBe(false);
});
it('commits the label atomically, rejects a foreign receipt and replays without creating a new one',async()=>{
  await claim();
  await expect(complete(uid(11))).rejects.toThrow('SHIPMENT_CLAIM_MISMATCH');
  expect((await db.query('select status from orders')).rows[0]).toEqual({status:'paid'});
  expect((await complete()).rows[0].r).toBe(true);
  expect((await complete()).rows[0].r).toBe(true);
  await expect(complete(uid(10),'87654321')).rejects.toThrow('SHIPMENT_RESULT_CONFLICT');
  expect((await claim(uid(12))).rows[0].r).toEqual({claimed:false,tracking_number:'12345678',label_url:'https://www.mondialrelay.fr/synthetic.pdf'});
  expect((await db.query('select status from orders')).rows[0]).toEqual({status:'shipped'});
});
it('does not undo a cancellation that occurred while the carrier was processing',async()=>{
  await claim();await db.query("update orders set status='cancelled'");await complete();
  expect((await db.query('select status,tracking_number from orders')).rows[0]).toEqual({status:'cancelled',tracking_number:'12345678'});
});
it('preserves delivery in the seller UI without restoring broad financial writes or updating another shop',async()=>{
  await db.exec(`reset role;insert into seller_profiles values('${uid(4)}','${uid(5)}');
    insert into order_items(order_id,seller_id)values('${uid(1)}','${uid(4)}');
    select set_config('test.uid','${uid(8)}',false);set role authenticated;`);
  const deliver=()=>db.query<{r:{order_delivered:boolean}}>('select mark_seller_order_delivered($1) as r',[uid(1)]);
  await expect(deliver()).rejects.toThrow('SHIPMENT_OWNER_REQUIRED');
  await db.query("select set_config('test.uid',$1,false)",[uid(3)]);
  expect((await deliver()).rows[0].r.order_delivered).toBe(false);
  await db.exec(`reset role`);
  expect((await db.query('select seller_id,status from order_items order by seller_id')).rows)
    .toEqual([{seller_id:uid(2),status:'delivered'},{seller_id:uid(4),status:'paid'}]);
  await db.exec(`select set_config('test.uid','${uid(5)}',false);set role authenticated;`);
  expect((await deliver()).rows[0].r.order_delivered).toBe(true);
  await expect(db.query("update orders set status='paid'")).rejects.toThrow(/permission denied/);
  const source=readFileSync('src/components/marketplace/SellerDashboard.tsx','utf8');
  expect(source).toContain(".rpc('mark_seller_order_delivered'");
  expect(source).not.toContain(".update({ status: 'delivered'");
});
