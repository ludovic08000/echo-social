import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export async function testAdLocationDatabase(db) {
  const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const q=(sql,args=[])=>db.query(sql,args);
  const scalar=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
  let checks=0;
  const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
  const denied=async(sql,args=[],pattern=/permission denied|AUTH_REQUIRED|ADULT_ONLY|INVALID_PREFERENCES|AD_NOT_DELIVERABLE/)=>{
    await assert.rejects(()=>q(sql,args),pattern);checks++;
  };
  const admin=()=>db.exec('RESET ROLE');
  const user=async(n,session=9001)=>{
    await admin();
    await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?uid(n):'']);
    await q("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({session_id:session?uid(session):undefined})]);
    await db.exec('SET ROLE authenticated');
  };
  const prefs=p=>scalar('SELECT set_discovery_preferences($1)',[JSON.stringify(p)]);
  const snapshot=()=>scalar('SELECT get_my_ad_location_context()');
  const ads=async()=>(await q('SELECT id FROM get_active_ads_for_placement()')).rows.map(x=>x.id);
  const consent={ads_location:true,ads_location_auto:true};
  const store=async(s,zone={country:'FR',region:'Grand Est',city:'Reims',source:'network'},n=1)=>{
    await admin();await db.exec('SET ROLE service_role');
    return scalar('SELECT store_ad_location_context($1,$2,$3,$4,$5,$6,$7)',[uid(n),s.sessionId,s.revision,zone.country,zone.region,zone.city,zone.source]);
  };
  await admin();
  await db.exec(`CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261005231753_consented_city_ad_delivery.sql',import.meta.url),'utf8'));
  await q("UPDATE ad_campaigns SET status='active',paid_at=now(),ends_at=now()+interval '1 day'");
  await db.exec('DELETE FROM user_message_blocks');
  await user(1);
  await prefs({});eq(await snapshot(),null);eq(await ads(),[uid(11)]);
  await prefs({local_media:true,country:'FR',region:'Grand Est',city:'Reims'});
  eq(await snapshot(),null);eq((await ads()).includes(uid(14)),false); // News is never advertising consent.
  await prefs({ads_location:true,country:'FR',region:'Grand Est',city:'Reims'});
  eq(await snapshot(),null);eq((await ads())[0],uid(14)); // Independent from local news, local creative first.
  eq((await scalar('SELECT get_my_ad_explanation($1)',[uid(14)])).zone.source,'selected');
  await prefs({ads_location:true});eq(await snapshot(),null);eq((await ads()).includes(uid(14)),false);
  await denied('SELECT set_discovery_preferences($1)',[JSON.stringify({ads_location_auto:true})]);
  await denied('SELECT set_discovery_preferences($1)',[JSON.stringify({...consent,ads_location_auto:'true'})]);
  await prefs(consent);
  let s=await snapshot();eq(s.sessionId,uid(9001));eq(s.cached,null);eq(s.profileCity,'Reims');
  await denied('SELECT * FROM ad_location_contexts');
  await denied('SELECT ad_effective_location_internal($1)',[uid(1)]);
  await denied('SELECT store_ad_location_context($1,$2,$3,$4,$5,$6,$7)',[uid(1),s.sessionId,s.revision,'FR','Grand Est','Reims','network']);
  eq(await store(s),true);
  await user(1);eq((await ads())[0],uid(14));eq((await snapshot()).cached.city,'Reims');
  const why=await scalar('SELECT get_my_ad_explanation($1)',[uid(14)]);
  eq(why.zone,{country:'FR',region:'Grand Est',city:'Reims',source:'network'});
  eq(await scalar("SELECT track_ad_interaction($1,'impression')",[uid(14)]),true);
  eq(await scalar("SELECT track_ad_interaction($1,'impression')",[uid(14)]),false);
  await user(1,9002);eq((await ads()).includes(uid(14)),false);eq((await snapshot()).cached,null);
  await denied("SELECT track_ad_interaction($1,'click')",[uid(14)]);
  const other=await snapshot();eq(await store(other,{country:'FR',region:'Île-de-France',city:'Paris',source:'network'}),true);
  await user(1,9002);eq((await snapshot()).cached.city,'Paris');eq((await ads()).includes(uid(14)),false);
  await user(5,9001);await prefs(consent);eq((await ads()).includes(uid(14)),false);eq((await snapshot()).cached,null);
  await user(1);eq((await ads()).includes(uid(14)),true); // Other login cannot overwrite this session.
  await prefs({local_media:true,country:'FR',region:'Grand Est',city:'Reims'});
  eq(await snapshot(),null);eq((await ads()).includes(uid(14)),false);
  eq(await store(s),false); // In-flight network result cannot restore withdrawn consent.
  await admin();eq(Number(await scalar('SELECT count(*) FROM ad_location_contexts WHERE user_id=$1',[uid(1)])),0);
  await user(1);await prefs(consent);s=await snapshot();
  eq(await store(s,{country:'FR',region:'Grand Est',city:null,source:'network'}),true);
  await user(1);eq((await ads()).includes(uid(14)),false); // Region is not evidence of a city.
  await admin();await q('UPDATE ad_sets SET target_location=$1 WHERE id=$2',[JSON.stringify({country:'FR',region:'Grand Est',villes:[]}),uid(14)]);
  await user(1);eq((await ads())[0],uid(14)); // Region-only campaigns remain eligible.
  await admin();await q("UPDATE ad_sets SET target_location=$1 WHERE id=$2",[JSON.stringify({country:'FR',region:'Grand Est',villes:['Reims']}),uid(14)]);
  eq(await store(s),true);
  await admin();await q("UPDATE ad_location_contexts SET expires_at=now()-interval '1 second' WHERE user_id=$1",[uid(1)]);
  await user(1);eq((await ads()).includes(uid(14)),false);eq((await snapshot()).cached,null);
  await admin();await db.exec('SELECT cleanup_discovery_data()');
  eq(Number(await scalar('SELECT count(*) FROM ad_location_contexts WHERE user_id=$1',[uid(1)])),0);
  eq(await store(s),true);
  await admin();await q("UPDATE profiles SET city='Paris' WHERE user_id=$1",[uid(1)]);
  eq(await store(s),false); // Profile changes invalidate pending lookups as well as saved zones.
  await user(1);eq((await ads()).includes(uid(14)),false);eq((await snapshot()).profileCity,'Paris');
  s=await snapshot();eq(await store(s,{country:null,region:null,city:null,source:'unavailable'}),true);
  await user(1);eq((await snapshot()).cached.source,'unavailable');eq((await ads()).includes(uid(14)),false);
  await prefs({...consent,country:'FR',region:'Grand Est',city:'Reims'});
  eq(await snapshot(),null);eq(await store(s),false);
  await user(1);eq((await ads()).includes(uid(14)),true);
  await prefs({});eq(await scalar('SELECT city FROM discovery_preferences WHERE user_id=auth.uid()'),null);
  for(const n of [2,3,6]){await user(n);eq(await snapshot(),null);await denied('SELECT set_discovery_preferences($1)',[JSON.stringify(consent)]);eq(await ads(),[]);}
  await user(1,0);await prefs(consent);eq(await snapshot(),null);eq((await ads()).includes(uid(14)),false);
  await q("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({session_id:'invalid'})]);
  eq(await snapshot(),null);eq((await ads()).includes(uid(14)),false);
  await admin();
  const match=(target,country,region,city)=>scalar('SELECT ad_location_matches_internal($1,$2,$3,$4,true)',[JSON.stringify(target),country,region,city]);
  eq(await match({country:'FR',region:'Auvergne-Rhône-Alpes',villes:['Saint-Étienne']},'FR','Auvergne Rhone Alpes','Saint Etienne'),true);
  eq(await match({country:'FR',region:'Grand Est',villes:['Reims']},'BE','Grand Est','Reims'),false);
  eq(await match({country:'FR',region:'Grand Est',villes:['Reims']},'FR','Île-de-France','Reims'),false);
  eq(await match({country:'FR',villes:['Reims']},'FR','Grand Est','Reims'),false); // Under-specified campaign, not guessed.
  await db.exec('SET ROLE anon');await denied('SELECT get_my_ad_location_context()');
  await user(null);await denied('SELECT get_my_ad_location_context()');
  console.log(`Ad location SQL: ${checks} functional checks passed (consent, city, session, expiry, revocation).`);
}
