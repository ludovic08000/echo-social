// Real migration/functions in isolated PostgreSQL; no production user data or network.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { testPartnerRssDatabase } from './test-partner-rss-database.mjs';
import { testRegionalMediaDatabase } from './test-regional-media-database.mjs';
import { testNewsDiscussionsDatabase } from './test-news-discussions-database.mjs';
import { testAdLocationDatabase } from './test-ad-location-database.mjs';
const db = new PGlite();
const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const q = (sql, args=[]) => db.query(sql, args);
const scalar = async (sql,args=[]) => Object.values((await q(sql,args)).rows[0])[0];
let checks=0;
const eq = (a,b) => { assert.deepEqual(a,b); checks++; };
const denied = async (sql,args=[],pattern=/permission denied|AUTH_REQUIRED|ADULT_ONLY|INVALID_PREFERENCES|AD_NOT_DELIVERABLE/) => {
  await assert.rejects(()=>q(sql,args),pattern); checks++;
};
const user = async n => { await db.exec('RESET ROLE'); await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?uid(n):'']); await db.exec('SET ROLE authenticated'); };
const admin = () => db.exec('RESET ROLE');
const prefs = p => scalar('SELECT set_discovery_preferences($1)',[JSON.stringify(p)]);
const refresh = () => scalar('SELECT refresh_my_ad_audience()');
const ads = async () => (await q("SELECT id FROM get_active_ads_for_placement('feed',30)")).rows.map(x=>x.id);
const eligible = async n => (await ads()).includes(uid(n));
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    CREATE TABLE profiles(user_id uuid PRIMARY KEY, name text, date_of_birth date, interests text[], city text);
    CREATE TABLE parental_controls(user_id uuid,is_minor boolean);
    CREATE TABLE privacy_settings(user_id uuid PRIMARY KEY,analytics_enabled boolean DEFAULT true,ai_data_sharing_enabled boolean DEFAULT true,profile_visibility text DEFAULT 'public',posts_visibility text DEFAULT 'public');
    CREATE TABLE posts(id uuid PRIMARY KEY,user_id uuid,body text,image_url text,created_at timestamptz DEFAULT now(),expires_at timestamptz,publish_at timestamptz);
    CREATE TABLE comments(id uuid PRIMARY KEY,user_id uuid,post_id uuid,body text,created_at timestamptz DEFAULT now(),is_zeus_reply boolean DEFAULT false);
    CREATE TABLE ml_interactions(user_id uuid,post_id uuid,surface text,exposure_id uuid,signal_type text,created_at timestamptz DEFAULT now());
    CREATE TABLE user_message_blocks(blocker_user_id uuid,blocked_user_id uuid);
    CREATE TABLE ad_campaigns(id uuid PRIMARY KEY,status text DEFAULT 'active',paid_at timestamptz DEFAULT now(),starts_at timestamptz DEFAULT now()-interval '1 day',ends_at timestamptz DEFAULT now()+interval '1 day',impressions int DEFAULT 0, clicks int DEFAULT 0,reach int DEFAULT 0,updated_at timestamptz);
    CREATE TABLE ad_sets(id uuid PRIMARY KEY,campaign_id uuid,placements text[] DEFAULT '{feed}',status text DEFAULT 'active',starts_at timestamptz DEFAULT now()-interval '1 day',ends_at timestamptz DEFAULT now()+interval '1 day',target_gender text DEFAULT 'all',target_age_min int DEFAULT 18,target_age_max int DEFAULT 65,target_location jsonb DEFAULT '{}',target_interests text[] DEFAULT '{}');
    CREATE TABLE ads(id uuid PRIMARY KEY,ad_set_id uuid,advertiser_id uuid,headline text DEFAULT 'Test',primary_text text DEFAULT 'Test',image_url text,video_url text,cta_text text,cta_url text,status text DEFAULT 'active',moderation_status text DEFAULT 'approved',impressions int DEFAULT 0,clicks int DEFAULT 0,reach int DEFAULT 0,updated_at timestamptz);
    CREATE TABLE ad_interactions(campaign_id uuid,ad_id uuid,user_id uuid,interaction_type text,placement text,interaction_day date,UNIQUE(user_id,ad_id,interaction_type,interaction_day));
    CREATE TABLE ad_daily_stats(campaign_id uuid,stat_date date,impressions int,clicks int,reach int,spent numeric,UNIQUE(campaign_id,stat_date));
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261005213316_consented_ads_and_local_media.sql',import.meta.url),'utf8'));
  for (let n=1;n<=6;n++) {
    await q('INSERT INTO auth.users VALUES($1)',[uid(n)]);
    await q("INSERT INTO profiles VALUES($1,'Test', $2, '{Sport}','Reims')",[uid(n),n===2?'2015-01-01':n===3?null:'1990-01-01']);
    await q('INSERT INTO privacy_settings(user_id) VALUES($1)',[uid(n)]);
  }
  await q('INSERT INTO parental_controls VALUES($1,true)',[uid(6)]);
  for (let n=11;n<=15;n++) {
    await q('INSERT INTO ad_campaigns(id) VALUES($1)',[uid(n)]);
    await q('INSERT INTO ad_sets(id,campaign_id) VALUES($1,$1)',[uid(n)]);
    await q('INSERT INTO ads(id,ad_set_id,advertiser_id) VALUES($1,$1,$2)',[uid(n),uid(4)]);
  }
  await q("UPDATE ad_sets SET target_interests='{Sport}' WHERE id=$1",[uid(12)]);
  await q("UPDATE ad_sets SET target_interests='{Santé}' WHERE id=$1",[uid(13)]);
  await q(`UPDATE ad_sets SET target_location='{"country":"FR","region":"Grand Est","villes":["Reims"]}' WHERE id=$1`,[uid(14)]);
  await q('UPDATE ad_sets SET target_age_min=25,target_age_max=45 WHERE id=$1',[uid(15)]);
  await user(1);
  eq(await ads(),[uid(11)]); // No implicit use of profile interests, age range or city.
  eq((await prefs({})).ads_activity,false);
  eq(await refresh(),[]);
  await denied('SELECT ad_adult_internal($1)',[uid(2)]);
  await denied('SELECT * FROM ad_audience_cache');
  await denied('INSERT INTO discovery_preferences(user_id) VALUES($1)',[uid(5)]);
  await denied('SELECT set_discovery_preferences($1)',[JSON.stringify({user_id:uid(5)})]);
  await denied('SELECT set_discovery_preferences($1)',[JSON.stringify({ads_profile:'true'})]);
  await denied('SELECT set_discovery_preferences($1)',[JSON.stringify({city:[]})]);
  await prefs({ads_profile:true});
  eq(await eligible(12),true); eq(await eligible(13),false); eq(await eligible(15),true);
  const why=await scalar('SELECT get_my_ad_explanation($1)',[uid(12)]);
  eq(why.topics,['Sport']); eq(why.advertiser,'Test');
  eq(await scalar("SELECT track_ad_interaction($1,'impression')",[uid(12)]),true);
  eq(await scalar("SELECT track_ad_interaction($1,'impression')",[uid(12)]),false);
  eq(await scalar("SELECT track_ad_interaction($1,'click')",[uid(12)]),true);
  eq(await scalar("SELECT track_ad_interaction($1,'click')",[uid(12)]),false);
  await prefs({});
  eq(await eligible(12),false);
  await denied("SELECT track_ad_interaction($1,'click')",[uid(12)]);
  eq(await scalar('SELECT get_my_ad_explanation($1)',[uid(12)]),null);
  for (const n of [2,3,6]) { await user(n); eq(await ads(),[]); await denied('SELECT set_discovery_preferences($1)',[JSON.stringify({ads_activity:true})]); }
  await user(5); await prefs({local_media:true,country:'FR',region:'Occitanie',city:'Toulouse'});
  await user(1); eq((await q('SELECT user_id FROM discovery_preferences')).rows.map(x=>x.user_id),[uid(1)]);
  await prefs({local_media:true,country:'fr',region:'Grand Est',city:'Reims'}); eq(await eligible(14),false);
  await prefs({local_media:true,ads_location:true,country:'fr',region:'Grand Est',city:'Reims'}); eq(await eligible(14),true);
  await prefs({local_media:false,ads_location:true,country:'FR',city:'Reims'});
  eq(await scalar('SELECT city FROM discovery_preferences'),null); eq(await eligible(14),false);
  // Only post-consent activity; repeated independent signals, not raw comments in audience records.
  await admin();
  await q("INSERT INTO posts(id,user_id,body,created_at) VALUES($1,$2,'football tennis',now()-interval '1 day'),($3,$2,'football',now()-interval '2 days')",[uid(101),uid(1),uid(102)]);
  await user(1); await prefs({ads_activity:true}); eq(await refresh(),[]);
  await admin(); await db.exec('DELETE FROM ad_audience_cache');
  await q("INSERT INTO posts(id,user_id,body) VALUES($1,$2,'concert guitare'),($3,$2,'piano musique'),($4,$2,'cancer football'),($5,$2,'je déteste football')",[uid(103),uid(1),uid(104),uid(105),uid(106)]);
  await user(1); eq(await refresh(),['Musique']);
  await admin(); await q("UPDATE posts SET body='piano musique' WHERE id=$1",[uid(103)]);
  eq(Number(await scalar('SELECT count(*) FROM ad_audience_cache')),0);
  await q("INSERT INTO posts(id,user_id,body,image_url) VALUES($1,$2,'jardinage potager','https://test.invalid/video.mp4'),($3,$2,'horticulture jardinage','https://test.invalid/video.webm')",[uid(110),uid(4),uid(111)]);
  await q("INSERT INTO ml_interactions(user_id,post_id,surface,exposure_id,signal_type) VALUES($1,$2,'feed',$3,'watch_complete'),($1,$4,'feed',$5,'watch_complete')",[uid(1),uid(110),uid(210),uid(111),uid(211)]);
  await q("INSERT INTO comments(id,user_id,post_id,body) VALUES($1,$2,$3,'recette cuisine'),($4,$2,$3,'pâtisserie cuisine')",[uid(300),uid(1),uid(110),uid(301)]);
  await user(1); eq((await refresh()).sort(),['Cuisine','Jardinage','Musique']);
  await admin(); await q("UPDATE privacy_settings SET posts_visibility='private' WHERE user_id=$1",[uid(4)]);
  eq(Number(await scalar('SELECT count(*) FROM ad_audience_cache')),0);
  await user(1); eq(await refresh(),['Musique']);
  await prefs({}); await admin(); eq(Number(await scalar('SELECT count(*) FROM ad_audience_cache')),0);
  await user(1); await prefs({ads_activity:true}); eq(await refresh(),[]); // Opt-in anew does not recover old topics.
  await admin(); await q("UPDATE privacy_settings SET analytics_enabled=false WHERE user_id=$1",[uid(1)]);
  await user(1); eq(await refresh(),[]);
  await admin();
  eq(await scalar("SELECT ad_text_topics_internal('religion guitare')"),[]);
  eq(await scalar("SELECT ad_text_topics_internal('football robotique')"),['Sport','Tech']);
  eq(await scalar("SELECT ad_location_matches_internal('[]',null,null,null,true)"),false);
  eq(await scalar(`SELECT ad_location_matches_internal('{"villes":"Reims"}','FR','Grand Est','Reims',true)`),false);
  eq(await scalar(`SELECT ad_location_matches_internal('{"gps":42}',null,null,null,true)`),false);
  eq(await scalar(`SELECT ad_location_matches_internal('{"country":42}',null,null,null,true)`),false);
  await q('UPDATE ad_campaigns SET paid_at=null WHERE id=$1',[uid(11)]);
  await user(1); eq(await eligible(11),false);
  await admin(); await q('UPDATE ad_campaigns SET paid_at=now() WHERE id=$1',[uid(11)]);
  await q('INSERT INTO user_message_blocks VALUES($1,$2)',[uid(4),uid(1)]);
  await user(1); eq(await ads(),[]);
  await admin(); await db.exec('DELETE FROM user_message_blocks');
  eq(await scalar('SELECT impressions FROM ads WHERE id=$1',[uid(12)]),1);
  eq(await scalar('SELECT reach FROM ads WHERE id=$1',[uid(12)]),1);
  // All partner records here are synthetic .invalid fixtures, never actual media agreements.
  await q(`INSERT INTO media_partners(id,name,website_host,region,city,agreement_reference,rights_until,active,allow_excerpt,allow_youtube_embed)
    VALUES($1,'Test Media','media.invalid','Grand Est','Reims','fixture',now()+interval '1 day',true,true,true)`,[uid(400)]);
  const insertItem=(id,url='https://media.invalid/article',other={})=>q(`INSERT INTO partner_media_items(id,partner_id,external_id,title,canonical_url,kind,excerpt,published_at,expires_at,moderated,family_safe,youtube_id)
    VALUES($1,$2,$3,'Titre',$4,$5,$6,now()-interval '1 hour',now()+interval '1 day',$7,$8,$9)`,[uid(id),uid(400),String(id),url,other.kind??'article',other.excerpt??'',other.moderated??true,other.family_safe??true,other.youtube_id??null]);
  await insertItem(401); await insertItem(402,undefined,{family_safe:false});
  await insertItem(403,undefined,{moderated:false});
  await insertItem(404,undefined,{kind:'video',youtube_id:'abcdefghijk',excerpt:'Extrait autorisé'});
  const batch=[{external_id:'batch-test',title:'Nouveau titre',canonical_url:'https://media.invalid/test',kind:'article',published_at:'2026-10-05T10:00:00Z',expires_at:new Date(Date.now()+3_600_000).toISOString()}];
  await db.exec('SET ROLE service_role');
  eq(await scalar('SELECT import_partner_media($1,$2)',[uid(400),JSON.stringify(batch)]),1);
  eq(await scalar('SELECT import_partner_media($1,$2)',[uid(400),JSON.stringify(batch)]),0);
  eq(await scalar("SELECT moderated FROM partner_media_items WHERE external_id='batch-test'"),false);
  await q("UPDATE partner_media_items SET moderated=true WHERE external_id='batch-test'");
  eq(await scalar('SELECT import_partner_media($1,$2)',[uid(400),JSON.stringify([{...batch[0],title:'Titre modifié'}])]),1);
  eq(await scalar("SELECT moderated FROM partner_media_items WHERE external_id='batch-test'"),false);
  await assert.rejects(()=>q('SELECT import_partner_media($1,$2)',[uid(400),JSON.stringify([{...batch[0],moderated:true}])]),/INVALID_MEDIA_ITEM/); checks++;
  await admin();
  await assert.rejects(()=>insertItem(405,'https://media.invalid.evil.test/article'),/INVALID_PARTNER_URL/); checks++;
  await q('UPDATE media_partners SET allow_excerpt=false WHERE id=$1',[uid(400)]);
  await assert.rejects(()=>insertItem(406,undefined,{excerpt:'non autorisé'}),/EXCERPT_RIGHTS_REQUIRED/); checks++;
  await q('UPDATE media_partners SET allow_youtube_embed=false WHERE id=$1',[uid(400)]);
  await assert.rejects(()=>insertItem(407,undefined,{kind:'video',youtube_id:'abcdefghijk'}),/EMBED_RIGHTS_REQUIRED/); checks++;
  const media= (scope='france',kind='all') => scalar('SELECT get_local_partner_media($1,$2)',[scope,kind]);
  await user(1); eq((await media()).length,3); eq((await media('france','video'))[0].youtube_id,null); eq((await media('france','video'))[0].excerpt,'');
  eq((await media('city')).length,0);
  await prefs({local_media:true,country:'FR',region:'Grand Est',city:'Reims'});
  eq((await media('city')).length,3); eq((await media('region')).length,3);
  await denied('SELECT * FROM media_partners'); await denied('SELECT * FROM partner_media_items');
  await denied('SELECT import_partner_media($1,$2)',[uid(400),JSON.stringify(batch)]);
  await user(5); eq((await media('city')).length,0);
  await user(2); eq((await media()).length,2);
  await user(3); eq((await media()).length,2);
  await admin(); await q('UPDATE media_partners SET active=false WHERE id=$1',[uid(400)]);
  await user(1); eq(await media(),[]);
  await admin(); await q("UPDATE media_partners SET active=true,rights_until=now()-interval '1 second' WHERE id=$1",[uid(400)]);
  await user(1); eq(await media(),[]);
  await admin(); await q("INSERT INTO ad_audience_cache VALUES($1,'{Sport}',now()-interval '6 minutes')",[uid(1)]);
  await db.exec('SELECT cleanup_discovery_data()'); eq(Number(await scalar('SELECT count(*) FROM ad_audience_cache')),0);
  await db.exec('SET ROLE anon'); await denied('SELECT get_local_partner_media()'); await denied('SELECT get_active_ads_for_placement()');
  await user(null); await denied('SELECT set_discovery_preferences($1)',['{}']);
  console.log(`Discovery SQL: ${checks} functional checks passed (isolated PostgreSQL; no production connection).`);
  await testPartnerRssDatabase(db);
  await testRegionalMediaDatabase(db);
  await testNewsDiscussionsDatabase(db);
  await testAdLocationDatabase(db);
} catch(error) { console.error(error.message,error.detail??'',error.where??''); process.exitCode=1; }
finally { await db.close(); }
