import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export async function testRegionalMediaDatabase(db) {
  await db.exec('RESET ROLE');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261005223753_regional_media_discovery.sql',import.meta.url),'utf8'));
  const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
  const q = (sql,args=[]) => db.query(sql,args);
  const scalar = async (sql,args=[]) => Object.values((await q(sql,args)).rows[0])[0];
  let checks = 0;
  const eq = (a,b) => {assert.deepEqual(a,b);checks++;};
  const denied = async (sql) => {await assert.rejects(()=>q(sql),/permission denied/);checks++;};
  const login = async (n) => {await db.exec('RESET ROLE');await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);await db.exec('SET ROLE authenticated');};
  const prefs = (local=true,region='Grand Est',city='Reims') => scalar('SELECT set_discovery_preferences($1)',[JSON.stringify({local_media:local,country:'FR',region,city})]);
  const media = (scope='nearby',kind='all') => scalar('SELECT get_local_partner_media($1,$2)',[scope,kind]);
  await q('INSERT INTO auth.users VALUES($1),($2),($3)',[id(710),id(711),id(712)]);
  await q("INSERT INTO profiles(user_id,date_of_birth,city) VALUES($1,'1990-01-01','Reims'),($2,'1990-01-01','Paris'),($3,'2015-01-01','Reims')",[id(710),id(711),id(712)]);
  for (const [n,region,city,host] of [[720,'Grand Est','Reims','city.invalid'],[721,'Grand Est',null,'region.invalid'],[722,null,null,'national.invalid'],[723,'Bretagne','Rennes','other.invalid'],[724,'Grand Est','Reims','city.invalid']]) {
    await q("INSERT INTO media_partners(id,name,website_host,region,city,agreement_reference,rights_until,active) VALUES($1,$2,$3,$4,$5,'test-only',now()+interval '5 days',true)",[id(n),`Fixture ${n}`,host,region,city]);
  }
  const insert = (n,partner,host,path,family=false) => q(`INSERT INTO partner_media_items(id,partner_id,external_id,title,canonical_url,kind,published_at,expires_at,moderated,family_safe)
    VALUES($1,$2,$3,'Synthetic news',$4,'article',now()-interval '1 day',now()+interval '1 day',true,$5)`,[id(n),id(partner),String(n),`https://${host}/${path}`,family]);
  for(let n=730;n<738;n++) await insert(n,720,'city.invalid',String(n),n===730);
  await insert(738,721,'region.invalid','r'); await insert(739,722,'national.invalid','n',true);
  await insert(740,723,'other.invalid','o'); await insert(741,724,'city.invalid','730'); // Same URL in two editions.
  await login(710); eq(await scalar('SELECT get_my_media_profile_city()'),'Reims');
  await prefs();
  const nearby=await media();
  eq(nearby.map(m=>m.proximity),['city','city','city','city','region','national']);
  eq(new Set(nearby.map(m=>m.canonical_url)).size,nearby.length);
  eq(nearby.filter(m=>m.canonical_url.startsWith('https://city.invalid/')).length,4);
  eq((await media('city')).length,4); eq((await media('region')).length,5);
  eq((await media('france')).some(m=>m.canonical_url==='https://other.invalid/o'),true);
  eq(await media('invalid'),[]); eq(await media('nearby','invalid'),[]);
  eq(await media('nearby','video'),[]);
  await prefs(true,'grand-est','REIMS'); eq((await media('city')).length,4);
  await prefs(true,'Bretagne','Rennes'); eq((await media()).map(m=>m.proximity),['city','national']);
  await prefs(true,'Grand Est','Unknown'); eq((await media('city')).length,0);
  eq((await media()).filter(m=>m.proximity==='city').length,0);
  await prefs(false); eq((await media()).map(m=>m.proximity),['national']); eq(await media('city'),[]);
  await login(711); eq(await scalar('SELECT get_my_media_profile_city()'),'Paris');
  eq((await media()).map(m=>m.proximity),['national']);
  await login(712); await prefs(); eq((await media()).length,2); // Only reviewed family-safe news.
  await login(null); eq(await scalar('SELECT get_my_media_profile_city()'),null); eq(await media(),[]);
  await db.exec('SET ROLE anon'); await denied('SELECT get_my_media_profile_city()'); await denied('SELECT get_local_partner_media()');
  await db.exec('SET ROLE authenticated'); await denied('SELECT get_partner_rss_coverage()');
  await denied('SELECT claim_partner_rss_sources()'); await denied('SELECT * FROM partner_rss_sources');
  await db.exec('RESET ROLE');
  // Verify fair bounded dispatch above the old 20-source/day ceiling.
  await q('UPDATE partner_rss_sources SET enabled=false');
  for(let n=760;n<790;n++) await q("INSERT INTO partner_rss_sources(id,partner_id,source_key,enabled) VALUES($1,$2,$3,true)",[id(n),id(721),`fixture-${n}`]);
  await db.exec('SET ROLE service_role');
  const first=await scalar('SELECT claim_partner_rss_sources(100)');const second=await scalar('SELECT claim_partner_rss_sources()');
  eq(first.length,20);eq(second.length,10);eq(await scalar('SELECT claim_partner_rss_sources()'),[]);
  eq(new Set([...first,...second].map(s=>s.id)).size,30);
  eq(first[0].country,'FR');eq(first[0].region,'Grand Est');eq(first[0].city,null);
  const coverage=await scalar('SELECT get_partner_rss_coverage()');
  eq(Number(coverage.find(r=>r.region==='Grand Est').authorized_sources),30);
  await db.exec('RESET ROLE');eq(await scalar('SELECT private.partner_rss_daily_tick()'),'NO_DUE_SOURCES');
  await db.exec('SET ROLE service_role');
  await q("UPDATE media_partners SET region='Bretagne' WHERE id=$1",[id(721)]);
  eq(Number(await scalar('SELECT count(*) FROM partner_rss_sources WHERE partner_id=$1 AND lease_token IS NOT NULL',[id(721)])),0);
  eq(await scalar("SELECT finish_partner_rss_import($1,$2,'[]','success')",[first[0].id,first[0].lease_token]),false);
  await q("UPDATE media_partners SET region='Grand Est' WHERE id=$1",[id(721)]);
  await db.exec('RESET ROLE');
  await q("UPDATE partner_rss_sources SET enabled=false WHERE partner_id=$1",[id(721)]);
  eq(await scalar('SELECT private.partner_rss_daily_tick()'),'NO_DUE_SOURCES');
  await q('UPDATE media_partners SET active=false WHERE id=$1',[id(720)]);
  await login(710);await prefs();eq((await media('city')).length,1); // Other authorized edition, never revoked publisher rows.
  console.log(`Regional media SQL: ${checks} functional checks passed (proximity, diversity, deduplication, consent, minors, account isolation and >20 sources).`);
}
