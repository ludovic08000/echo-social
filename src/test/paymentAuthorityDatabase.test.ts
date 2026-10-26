// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,beforeEach,expect,it } from 'vitest';
let db:PGlite;
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated,service_role;
    create type order_status as enum('pending','paid','processing','shipped','delivered','cancelled','refunded');
    create table orders(id uuid primary key,buyer_id uuid,status order_status,total numeric,paid_at timestamptz,payment_intent_id text);
    create table order_items(order_id uuid,product_id uuid,seller_id uuid,quantity int,status order_status);
    create table products(id uuid primary key,stock_quantity int,is_active bool default true,seller_id uuid,price numeric);
    create table seller_profiles(id uuid,user_id uuid); create table cart_items(user_id uuid);
    create table notifications(user_id uuid,actor_id uuid,type text);
    create table negotiations(id uuid primary key,product_id uuid,buyer_id uuid,seller_profile_id uuid,conversation_id uuid,
      original_price numeric,offered_price numeric,counter_price numeric,status text default 'pending',order_id uuid,created_at timestamptz default now());
    grant all on all tables in schema public to authenticated,service_role;
  `);
  const stock=readFileSync('supabase/migrations/20260422052252_4a975c01-1e7b-490d-81bb-3ebe7b833cde.sql','utf8');
  await db.exec(stock.slice(stock.indexOf('CREATE OR REPLACE FUNCTION public.decrement_product_stock('),stock.indexOf('-- 4) PRIVACY IA')));
  await db.exec(readFileSync('supabase/migrations/20261018203110_secure_marketplace_payment_authority.sql','utf8'));
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;truncate marketplace_payment_receipts,orders,order_items,products,seller_profiles,cart_items,notifications,negotiations;
    insert into orders(id,buyer_id,status,total) values('${uid(1)}','${uid(2)}','pending',100),('${uid(5)}','${uid(2)}','pending',100);
    insert into products values('${uid(3)}',10,true,'${uid(4)}',100); insert into seller_profiles values('${uid(4)}','${uid(6)}');
    insert into order_items values('${uid(1)}','${uid(3)}','${uid(4)}',2,'pending'),('${uid(5)}','${uid(3)}','${uid(4)}',1,'pending');
    insert into cart_items values('${uid(2)}');set role service_role;`);
});
afterAll(async()=>{await db?.close()});
const settle=(id=uid(1),intent='pi_exact',amount=10000,buyer=uid(2))=>db.query('select settle_marketplace_payment($1,$2,$3,$4,$5,$6) as settled',[id,buyer,'cs_exact',intent,amount,'eur']);
it('denies direct order and item writes while preserving reads',async()=>{
  await db.exec('set role authenticated');
  await expect(db.query(`update orders set status='paid'`)).rejects.toThrow(/permission denied/);
  await expect(db.query(`insert into orders(id,status) values('${uid(7)}','paid')`)).rejects.toThrow(/permission denied/);
  await expect(db.query(`update order_items set quantity=999`)).rejects.toThrow(/permission denied/);
  await expect(settle()).rejects.toThrow(/permission denied/);
  expect((await db.query('select id from orders')).rows).toHaveLength(2);
});
it('settles stock, statuses, receipt, notification and cart atomically and exactly once',async()=>{
  expect((await settle()).rows[0]).toEqual({settled:true});
  expect((await settle()).rows[0]).toEqual({settled:false});
  expect((await db.query('select stock_quantity from products')).rows[0]).toEqual({stock_quantity:8});
  expect((await db.query('select * from notifications')).rows).toHaveLength(1);
  expect((await db.query('select * from cart_items')).rows).toHaveLength(0);
  expect((await db.query('select status,payment_verified_at is not null as verified from orders where id=$1',[uid(1)])).rows[0]).toEqual({status:'paid',verified:true});
});
it('rejects foreign buyer, wrong amount and reused proof on another order',async()=>{
  await expect(settle(uid(1),'pi_exact',1)).rejects.toThrow('PAYMENT_BINDING_MISMATCH');
  await expect(settle(uid(1),'pi_exact',10000,uid(9))).rejects.toThrow('PAYMENT_BINDING_MISMATCH');
  await settle();
  await expect(settle(uid(5))).rejects.toThrow(/unique/);
});
it('rolls back the receipt and every side effect when stock fails',async()=>{
  await db.query('update products set stock_quantity=1');
  await expect(settle()).rejects.toThrow('INSUFFICIENT_STOCK');
  expect((await db.query('select * from marketplace_payment_receipts')).rows).toHaveLength(0);
  expect((await db.query('select * from notifications')).rows).toHaveLength(0);
  expect((await db.query('select status from orders where id=$1',[uid(1)])).rows[0]).toEqual({status:'pending'});
});
it('does not decrement a previously fulfilled historical order twice',async()=>{
  await db.query(`update orders set status='delivered' where id=$1`,[uid(1)]);
  await settle();
  expect((await db.query('select stock_quantity from products')).rows[0]).toEqual({stock_quantity:10});
  expect((await db.query('select status from orders where id=$1',[uid(1)])).rows[0]).toEqual({status:'delivered'});
});
it('requires seller consent and exact counter-offer acceptance before a negotiated price is payable',async()=>{
  await db.exec(`reset role;select set_config('test.uid','${uid(2)}',false);set role authenticated`);
  const insert=(status='pending')=>db.query('insert into negotiations(id,product_id,buyer_id,seller_profile_id,original_price,offered_price,status)values($1,$2,$3,$4,1,40,$5)',[uid(7),uid(3),uid(2),uid(4),status]);
  await expect(insert('accepted')).rejects.toThrow('NEGOTIATION_CREATION_FORBIDDEN');
  await insert();
  expect((await db.query('select original_price from negotiations')).rows[0]).toEqual({original_price:'100'});
  await expect(db.query("update negotiations set status='accepted'")).rejects.toThrow('BUYER_CANNOT_APPROVE_OFFER');
  await db.exec(`reset role;select set_config('test.uid','${uid(6)}',false);set role authenticated`);
  await db.query("update negotiations set status='counter',counter_price=50");
  await db.exec(`reset role;select set_config('test.uid','${uid(2)}',false);set role authenticated`);
  await expect(db.query("update negotiations set status='accepted',offered_price=1")).rejects.toThrow('BUYER_CANNOT_APPROVE_OFFER');
  await db.query("update negotiations set status='accepted',offered_price=50");
  expect((await db.query('select status from negotiations')).rows[0]).toEqual({status:'accepted'});
});
