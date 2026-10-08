import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Called by the discovery suite using its isolated PostgreSQL instance, never production.
export async function testPartnerRssDatabase(db) {
  await db.exec('RESET ROLE');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261005221140_daily_partner_rss.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261008130000_restore_partner_media_delivery.sql', import.meta.url), 'utf8'));
  const q = (sql, args=[]) => db.query(sql, args);
  const scalar = async (sql, args=[]) => Object.values((await q(sql, args)).rows[0])[0];
  let checks = 0;
  const eq = (a,b) => { assert.deepEqual(a,b); checks++; };
  const denied = async (sql, args=[]) => { await assert.rejects(() => q(sql,args), /permission denied|INVALID_RSS/); checks++; };
  const partner = '00000000-0000-4000-8000-000000000600';
  const source = '00000000-0000-4000-8000-000000000601';
  const item = { external_id: 'rss:'+'a'.repeat(64), title: 'Fixture news', kind: 'article', canonical_url: 'https://rss.invalid/article', excerpt: '', published_at: new Date(Date.now()-3600000).toISOString(), expires_at: new Date(Date.now()+86400000).toISOString() };
  const claim = () => scalar('SELECT claim_partner_rss_sources()');
  const finish = (lease, items=[item], status='success', etag='"one"', error=null) => scalar('SELECT finish_partner_rss_import($1,$2,$3,$4,$5,NULL,$6)', [source,lease,JSON.stringify(items),status,etag,error]);
  const due = () => q("UPDATE partner_rss_sources SET next_fetch_at=now()-interval '1 second' WHERE id=$1",[source]);
  const approved = () => scalar('SELECT moderated FROM partner_media_items WHERE partner_id=$1',[partner]);
  await q("INSERT INTO media_partners(id,name,website_host,agreement_reference,rights_until,active) VALUES($1,'Synthetic RSS fixture','rss.invalid','test-only',now()+interval '1 day',true)",[partner]);
  await q("INSERT INTO partner_rss_sources(id,partner_id,source_key) VALUES($1,$2,'fixture')",[source,partner]);
  for (const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await denied('SELECT * FROM partner_rss_sources');
    await denied('SELECT claim_partner_rss_sources()');
    await denied('SELECT finish_partner_rss_import($1,$2,\'[]\',\'success\')',[source,source]);
  }
  await db.exec('SET ROLE service_role');
  eq(await claim(),[]); // New sources are disabled by default.
  await q('UPDATE partner_rss_sources SET enabled=true WHERE id=$1',[source]);
  await q('UPDATE media_partners SET active=false WHERE id=$1',[partner]); eq(await claim(),[]);
  await q("UPDATE media_partners SET active=true,rights_until=now()-interval '1 second' WHERE id=$1",[partner]); eq(await claim(),[]);
  await q("UPDATE media_partners SET rights_until=now()+interval '1 day' WHERE id=$1",[partner]);
  const [first] = await claim(); eq(first.partner_id,partner); eq(await claim(),[]);
  eq(await finish(source),false); // Forged/stale token cannot publish.
  eq(await finish(first.lease_token),true); eq(await approved(),false);
  eq(await scalar('SELECT last_status FROM partner_rss_sources WHERE id=$1',[source]),'success');
  eq(await claim(),[]); // Successful repeated dispatch the same day does no work.
  await q('UPDATE partner_rss_sources SET auto_publish=true WHERE id=$1',[source]);
  eq(await scalar('SELECT etag FROM partner_rss_sources WHERE id=$1',[source]),null);
  const [second] = await claim(); eq(await finish(second.lease_token),true);
  eq(await approved(),false); // Enabling automatic publication must not reverse prior review decisions.
  const newItem = { ...item, external_id:'rss:'+'b'.repeat(64), canonical_url:'https://rss.invalid/new' };
  await due(); const [third] = await claim(); eq(await finish(third.lease_token,[newItem]),true);
  eq(await scalar('SELECT moderated FROM partner_media_items WHERE external_id=$1',[newItem.external_id]),true);
  eq(await scalar('SELECT family_safe FROM partner_media_items WHERE external_id=$1',[newItem.external_id]),false);
  await due(); const [fourth] = await claim();
  eq(await finish(fourth.lease_token,[{ ...newItem, title:'Edited title' }]),true);
  eq(await scalar('SELECT moderated FROM partner_media_items WHERE external_id=$1',[newItem.external_id]),true);
  await q('UPDATE partner_media_items SET moderated=false WHERE external_id=$1',[newItem.external_id]);
  await due(); const [rejected] = await claim();
  eq(await finish(rejected.lease_token,[{ ...newItem, title:'Rejected edit stays rejected' }]),true);
  eq(await scalar('SELECT moderated FROM partner_media_items WHERE external_id=$1',[newItem.external_id]),false);
  eq(Number(await scalar('SELECT count(*) FROM partner_media_items WHERE partner_id=$1',[partner])),2);
  await due(); const [cached] = await claim(); eq(cached.etag,'"one"');
  eq(await finish(cached.lease_token,[],'not_modified'),true);
  await due(); const [failed] = await claim(); eq(await finish(failed.lease_token,[],'failure',null,'FETCH_FAILED'),true);
  eq(await scalar('SELECT etag FROM partner_rss_sources WHERE id=$1',[source]),'"one"');
  eq(await scalar('SELECT last_error FROM partner_rss_sources WHERE id=$1',[source]),'FETCH_FAILED');
  await due(); const [invalid] = await claim();
  await denied('SELECT finish_partner_rss_import($1,$2,\'[]\',\'nonsense\')',[source,invalid.lease_token]);
  await denied('SELECT finish_partner_rss_import($1,$2,$3,\'success\')',[source,invalid.lease_token,JSON.stringify([{...item,published_at:new Date(Date.now()+86400000).toISOString()}])]);
  await q('UPDATE partner_rss_sources SET enabled=false WHERE id=$1',[source]);
  eq(await finish(invalid.lease_token),false); // Disabling mid-flight invalidates the worker.
  await q('UPDATE partner_rss_sources SET enabled=true WHERE id=$1',[source]);
  const [expiredLease] = await claim();
  await q("UPDATE partner_rss_sources SET lease_until=now()-interval '1 second' WHERE id=$1",[source]);
  const [reclaimed] = await claim(); assert.notEqual(reclaimed.lease_token,expiredLease.lease_token); checks++;
  eq(await finish(expiredLease.lease_token),false);
  await q('UPDATE media_partners SET active=false WHERE id=$1',[partner]);
  eq(await finish(reclaimed.lease_token),false); // Agreement/partner revoked while fetching.
  eq(await scalar('SELECT last_status FROM partner_rss_sources WHERE id=$1',[source]),'disabled');
  await db.exec('RESET ROLE');
  eq(await scalar('SELECT private.partner_rss_daily_tick()'),'NO_ENABLED_SOURCES');
  await q('UPDATE media_partners SET active=true WHERE id=$1',[partner]);
  eq(await scalar('SELECT private.partner_rss_daily_tick()'),'SECRET_NOT_CONFIGURED');
  console.log(`Daily RSS SQL: ${checks} functional checks passed (leases, roles, rights, deduplication, publication and rollback).`);
  return checks;
}
