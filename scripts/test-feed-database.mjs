// Executes the production serving migration against an isolated PostgreSQL WASM
// instance. Only the upstream candidate/scoring services are deterministic stubs.
// It does not connect to Lovable Cloud or validate real pgvector query plans.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const read = (name) => readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
let checks = 0;
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE quality_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$SELECT jsonb_build_object('role', 'authenticated')$$;
    CREATE TABLE posts(id uuid PRIMARY KEY, user_id uuid, body text, image_url text, media_thumbnail_url text,
      created_at timestamptz DEFAULT now(), expires_at timestamptz, publish_at timestamptz,
      likes_count integer DEFAULT 0, comments_count integer DEFAULT 0);
    CREATE TABLE profiles(user_id uuid PRIMARY KEY, name text, avatar_url text, mood_emoji text);
    CREATE TABLE privacy_settings(user_id uuid PRIMARY KEY, profile_visibility text, posts_visibility text, analytics_enabled boolean);
    CREATE TABLE user_feed_preferences(user_id uuid PRIMARY KEY, feed_algorithm text, muted_keywords text[],
      sensitive_content_filter boolean, seen_posts_hide boolean);
    CREATE TABLE friendships(requester_id uuid, addressee_id uuid, status text);
    CREATE TABLE user_message_blocks(blocker_user_id uuid, blocked_user_id uuid);
    CREATE TABLE parental_controls(user_id uuid, is_active boolean, is_minor boolean, allowed_categories text[]);
    CREATE FUNCTION parental_content_category_allowed(text,text[],text[],text[]) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
    CREATE TABLE ml_post_features(post_id uuid PRIMARY KEY, topics text[], hashtags text[],
      content_sensitivity_score numeric, repetitive_score numeric, novelty_score numeric);
    CREATE TABLE ml_creator_features(creator_id uuid, quality_score numeric, fatigue_score numeric);
    CREATE TABLE likes(post_id uuid, user_id uuid, reaction_type text);
    CREATE TABLE ml_interactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, post_id uuid,
      signal_type text, weight numeric, dwell_ms integer, created_at timestamptz DEFAULT now());
    CREATE TABLE ml_feed_experiments(key text PRIMARY KEY, status text, traffic_split numeric,
      variant_a jsonb, variant_b jsonb, updated_at timestamptz DEFAULT now());
    CREATE TABLE ml_feed_experiment_events(id uuid DEFAULT gen_random_uuid(), user_id uuid, experiment_key text,
      variant text, post_id uuid, event_type text, surface text, dwell_ms integer, weight numeric, metadata jsonb);
    CREATE FUNCTION ml_record_feed_ab_events(jsonb) RETURNS integer LANGUAGE sql AS $$SELECT 0$$;
    CREATE FUNCTION ml_record_watch_time(uuid,numeric,integer) RETURNS void LANGUAGE sql AS $$SELECT$$;
    CREATE FUNCTION ml_retrieve_feed_candidates_v8(uuid,integer)
      RETURNS TABLE(post_id uuid,retrieval_source text,retrieval_score numeric)
      LANGUAGE sql AS $$SELECT id, 'test', 0.5::numeric FROM public.posts ORDER BY id LIMIT $2$$;
    CREATE FUNCTION feed_score_batch(uuid,uuid[],text)
      RETURNS TABLE(post_id uuid,final_score numeric,ml_score numeric,classic_score numeric,reason text)
      LANGUAGE sql AS $$SELECT x, 50::numeric, 0.5::numeric, 50::numeric, 'fixture'::text FROM unnest($2) x$$;
    CREATE FUNCTION feed_post_is_eligible_internal(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
  `);
  const old = read('20260929235900_secure_feed_visibility_and_cursor.sql');
  await db.exec(old.slice(old.indexOf('CREATE TABLE'), old.indexOf('-- Set-wise')));
  await db.exec(read('20261005202721_harden_feed_serving_and_events.sql'));
  // The real pre-existing preference trigger changes snapshot items before insertion.
  await db.exec(`
    CREATE FUNCTION test_preferences() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN SELECT jsonb_agg(value ORDER BY value->>'id' DESC) INTO NEW.items FROM jsonb_array_elements(NEW.items); RETURN NEW; END $$;
    CREATE TRIGGER apply_feed_preferences_to_snapshot BEFORE INSERT ON feed_rank_snapshots
      FOR EACH ROW EXECUTE FUNCTION test_preferences();
    INSERT INTO ml_feed_experiments(key,status,traffic_split,variant_a,variant_b)
      VALUES ('recsys_v8_main','running',50,'{}','{}');
  `);
  for (let n = 1; n <= 5; n++) {
    await db.query('INSERT INTO auth.users VALUES ($1)', [uid(n)]);
    await db.query("INSERT INTO profiles VALUES ($1,'test',null,null)", [uid(n)]);
    await db.query("INSERT INTO privacy_settings VALUES ($1,'public','public',true)", [uid(n)]);
  }
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid(1)]);
  await db.query("INSERT INTO user_feed_preferences(user_id,feed_algorithm) VALUES ($1,'chronological')", [uid(1)]);
  for (let n = 11; n <= 30; n++) await db.query(
    "INSERT INTO posts(id,user_id,body) VALUES($1,$2,'post')", [uid(n), uid(n % 3 + 2)]);
  const page1 = await scalar('SELECT get_ranked_feed_page(4,null)');
  const page2 = await scalar('SELECT get_ranked_feed_page(4,$1)', [page1.next_cursor]);
  const stored = await scalar('SELECT items FROM feed_rank_snapshots LIMIT 1');
  assert.deepEqual([...page1.items,...page2.items].map(p=>p.id), stored.slice(0,8).map(p=>p.id)); checks++;
  assert.equal(new Set([...page1.items,...page2.items].map(p=>p.id)).size,8); checks++;
  assert.ok(page1.items.every(p=>p.exposure_id)); checks++;
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid(5)]);
  await assert.rejects(()=>db.query('SELECT get_ranked_feed_page(4,$1)',[page1.next_cursor]),/invalid or expired/); checks++;
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid(1)]);
  const post = page1.items[0];
  const event = {event_id:uid(100),post_id:post.id,exposure_id:post.exposure_id,event_type:'view',weight:999};
  assert.equal(await scalar('SELECT ml_ingest_feed_events($1)',[JSON.stringify([event])]),1); checks++;
  assert.equal(await scalar('SELECT ml_ingest_feed_events($1)',[JSON.stringify([event])]),0); checks++;
  assert.equal(Number(await scalar('SELECT weight FROM ml_interactions LIMIT 1')),0.5); checks++;
  assert.equal(await scalar('SELECT variant FROM ml_feed_experiment_events LIMIT 1'),post.experiment_variant); checks++;
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid(5)]);
  assert.equal(await scalar('SELECT ml_ingest_feed_events($1)',[JSON.stringify([{...event,event_id:uid(101)}])]),0); checks++;
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid(1)]);
  await db.query("UPDATE privacy_settings SET profile_visibility='private' WHERE user_id=$1",[post.user_id]);
  assert.equal(await scalar('SELECT count(*)::integer FROM feed_eligible_post_ids_internal($1,$2)',[uid(1),[post.id]]),0); checks++;
  assert.equal(await scalar("SELECT has_table_privilege('authenticated','ml_interactions','INSERT')"),false); checks++;
  assert.equal(await scalar("SELECT has_function_privilege('anon','ml_ingest_feed_events(jsonb)','EXECUTE')"),false); checks++;
  await db.query("UPDATE privacy_settings SET analytics_enabled=false WHERE user_id=$1",[uid(1)]);
  assert.equal(await scalar('SELECT ml_ingest_feed_events($1)',[JSON.stringify([{...event,event_id:uid(102),event_type:'click'}])]),0); checks++;
  await db.query("UPDATE feed_rank_cursors SET expires_at=now() - interval '1 second',created_at=now()-interval '1 minute'");
  await assert.rejects(()=>db.query('SELECT get_ranked_feed_page(4,$1)',[page1.next_cursor]),/invalid or expired/); checks++;
  // Clear JWT: exercise the assignment function over distinct deterministic users.
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  const bShare = await scalar(`SELECT avg((a.variant='b')::int) FROM generate_series(1,10000) n
    CROSS JOIN LATERAL ml_recsys_v8_assignment(md5(n::text)::uuid,'recsys_v8_main') a`);
  assert.ok(Number(bShare)>.48 && Number(bShare)<.52); checks++;
  // Execute the production lifecycle functions. Text stands in for the vector
  // column only in this fixture: these tests exercise leases/CAS, not pgvector.
  await db.exec(`
    ALTER TABLE privacy_settings ADD ai_data_sharing_enabled boolean DEFAULT false,
      ADD ai_personalization_enabled boolean DEFAULT false;
    ALTER TABLE ml_post_features ADD embedding text, ADD embedding_text text,
      ADD embedding_source text, ADD embedding_updated_at timestamptz,
      ADD updated_at timestamptz, ADD sentiment numeric, ADD quality_score numeric,
      ADD language text, ADD has_media boolean, ADD creator_id uuid;
    ALTER TABLE ml_post_features ADD avg_watch_time_ms numeric, ADD watch_sample_count integer,
      ADD positive_count integer, ADD negative_count integer, ADD wellbeing_score numeric;
    CREATE TABLE user_interests(user_id uuid,interest_value text,weight numeric);
    CREATE FUNCTION ml_pareto_score_batch(uuid,uuid[]) RETURNS TABLE(post_id uuid,score numeric)
      LANGUAGE sql AS $$SELECT x, 0.5::numeric FROM unnest($2) x$$;
    CREATE TABLE feed_algorithm_config(key text PRIMARY KEY,value jsonb,updated_at timestamptz);
    CREATE TABLE feed_config_change_log(id uuid PRIMARY KEY,config_key text,new_value jsonb,old_value jsonb,
      rolled_back boolean DEFAULT false,rolled_back_at timestamptz);
  `);
  const lifecycle = read('20261005203253_feed_training_lifecycle.sql');
  await db.exec(lifecycle.slice(0,lifecycle.indexOf('-- Same vector space'))+'COMMIT;');
  await db.exec(lifecycle.slice(lifecycle.indexOf('CREATE OR REPLACE FUNCTION public.feed_score_batch('),lifecycle.indexOf('CREATE OR REPLACE FUNCTION public.ml_retrieve_feed_candidates_v8(')));
  await db.exec(lifecycle.slice(lifecycle.indexOf('CREATE OR REPLACE FUNCTION public.rollback_feed_legacy_config'),lifecycle.indexOf('CREATE OR REPLACE FUNCTION public.feed_ml_health')));
  assert.equal(Number(await scalar('SELECT count(*) FROM claim_feed_feature_jobs(40)')),0); checks++;
  await db.query("UPDATE privacy_settings SET profile_visibility='public',ai_data_sharing_enabled=true,ai_personalization_enabled=true WHERE user_id=$1",[uid(2)]);
  const jobs = (await db.query('SELECT * FROM claim_feed_feature_jobs(40)')).rows;
  assert.ok(jobs.length>0 && jobs.every(j=>j.user_id===uid(2))); checks++;
  assert.equal(Number(await scalar('SELECT count(*) FROM claim_feed_feature_jobs(40)')),0); checks++;
  const job = jobs[0];
  const feature = {topics:['test'],hashtags:[],sentiment:0,quality:0.5,language:'fr',embedding:'[0.1,0.2]',embedding_source:'fixture'};
  await db.query("UPDATE posts SET body='changed' WHERE id=$1",[job.post_id]);
  assert.equal(await scalar('SELECT finish_feed_feature_job($1,$2,$3)',[job.post_id,job.revision,JSON.stringify(feature)]),false); checks++;
  const edited = (await db.query('SELECT * FROM claim_feed_feature_jobs(40)')).rows[0];
  assert.notEqual(edited.revision,job.revision); checks++;
  await db.query("UPDATE feed_feature_jobs SET lease_until=now()-interval '1 second' WHERE post_id=$1",[job.post_id]);
  const reclaimed = (await db.query('SELECT * FROM claim_feed_feature_jobs(40)')).rows[0];
  assert.notEqual(reclaimed.revision,edited.revision); checks++;
  assert.equal(await scalar('SELECT finish_feed_feature_job($1,$2,$3)',[edited.post_id,edited.revision,JSON.stringify(feature)]),false); checks++;
  assert.equal(await scalar('SELECT finish_feed_feature_job($1,$2,$3)',[reclaimed.post_id,reclaimed.revision,JSON.stringify(feature)]),true); checks++;
  assert.equal(await scalar('SELECT status FROM feed_feature_jobs WHERE post_id=$1',[job.post_id]),'ready'); checks++;
  await db.query("UPDATE privacy_settings SET ai_data_sharing_enabled=false WHERE user_id=$1",[uid(2)]);
  const optedOut = jobs[1];
  assert.equal(await scalar('SELECT finish_feed_feature_job($1,$2,$3)',[optedOut.post_id,optedOut.revision,JSON.stringify(feature)]),false); checks++;
  assert.equal(await scalar('SELECT status FROM feed_feature_jobs WHERE post_id=$1',[optedOut.post_id]),'skipped'); checks++;
  assert.equal(await scalar('SELECT claim_feed_training_lease($1,$2)',['features',uid(80)]),true); checks++;
  assert.equal(await scalar('SELECT claim_feed_training_lease($1,$2)',['features',uid(81)]),false); checks++;
  await db.exec("UPDATE feed_training_leases SET expires_at=now()-interval '1 second'");
  assert.equal(await scalar('SELECT claim_feed_training_lease($1,$2)',['features',uid(81)]),true); checks++;
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','claim_feed_feature_jobs(integer)','EXECUTE')"),false); checks++;
  await db.query("INSERT INTO feed_algorithm_config VALUES('test','2',now())");
  await db.query("INSERT INTO feed_config_change_log(id,config_key,new_value,old_value) VALUES($1,'test','2','1')",[uid(90)]);
  assert.equal((await scalar('SELECT rollback_feed_legacy_config($1)',[uid(90)])).status,'ok'); checks++;
  assert.equal(await scalar("SELECT value FROM feed_algorithm_config WHERE key='test'"),1); checks++;
  await assert.rejects(()=>db.query('SELECT rollback_feed_legacy_config($1)',[uid(90)]),/unavailable/); checks++;
  await db.query("INSERT INTO feed_config_change_log(id,config_key,new_value,old_value) VALUES($1,'test','2','1')",[uid(91)]);
  await assert.rejects(()=>db.query('SELECT rollback_feed_legacy_config($1)',[uid(91)]),/changed since/); checks++;
  const snapshotCount = await scalar('SELECT count(*) FROM feed_rank_snapshots');
  const exposureCount = await scalar('SELECT count(*) FROM feed_served_items');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)",[uid(1)]);
  const preview = await scalar('SELECT preview_feed_training_order($1,4)',[uid(1)]);
  assert.equal(preview.length,4); checks++;
  assert.equal(await scalar('SELECT count(*) FROM feed_rank_snapshots'),snapshotCount); checks++;
  assert.equal(await scalar('SELECT count(*) FROM feed_served_items'),exposureCount); checks++;
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','preview_feed_training_order(uuid,integer)','EXECUTE')"),false); checks++;
  const scoreWithoutInterests = await scalar("SELECT classic_score FROM feed_score_batch($1,$2,'smart')",[uid(1),[uid(12)]]);
  const currentBody = await scalar('SELECT body FROM posts WHERE id=$1',[uid(12)]);
  await db.query("INSERT INTO user_interests VALUES($1,$2,100)",[uid(1),currentBody]);
  assert.equal(await scalar("SELECT classic_score FROM feed_score_batch($1,$2,'smart')",[uid(1),[uid(12)]]),scoreWithoutInterests); checks++;
  await db.query("UPDATE privacy_settings SET ai_personalization_enabled=true WHERE user_id=$1",[uid(1)]);
  assert.ok(Number(await scalar("SELECT classic_score FROM feed_score_batch($1,$2,'smart')",[uid(1),[uid(12)]]))>Number(scoreWithoutInterests)); checks++;
  // The new evaluation contract must not change the live ordering.
  await db.query("UPDATE user_feed_preferences SET feed_algorithm='smart' WHERE user_id=$1",[uid(1)]);
  const fixtureItems = Array.from({length:20},(_,i)=>({id:uid(i+11),user_id:uid(i%3+2)}));
  const oldOrder = await scalar('INSERT INTO feed_rank_snapshots(viewer_id,items) VALUES($1,$2) RETURNING items',[uid(1),JSON.stringify(fixtureItems)]);
  await db.exec(read('20261005211535_feed_offline_evaluation_contract.sql'));
  const newOrder = await scalar('INSERT INTO feed_rank_snapshots(viewer_id,items) VALUES($1,$2) RETURNING items',[uid(1),JSON.stringify(fixtureItems)]);
  assert.deepEqual(newOrder,oldOrder); checks++;
  await db.exec("UPDATE privacy_settings SET analytics_enabled=true,ai_personalization_enabled=true,ai_data_sharing_enabled=true,profile_visibility='public',posts_visibility='public'");
  const evaluationPage = await scalar('SELECT get_ranked_feed_page(8,null)');
  const evaluationSnapshot = await scalar('SELECT snapshot_id FROM feed_served_items WHERE id=$1',[evaluationPage.items[0].exposure_id]);
  const replayExport = async () => await scalar('SELECT feed_evaluation_slates(50,now())');
  assert.equal((await replayExport()).slates.length,0); checks++; // Five-minute feedback maturity.
  await db.query("UPDATE feed_rank_snapshots SET created_at=now()-interval '10 minutes' WHERE id=$1",[evaluationSnapshot]);
  await db.query("UPDATE feed_served_items SET served_at=now()-interval '9 minutes' WHERE snapshot_id=$1",[evaluationSnapshot]);
  for(let i=0;i<5;i++) await db.query(`INSERT INTO ml_interactions(user_id,post_id,signal_type,weight,exposure_id,surface,created_at)
    VALUES($1,$2,$3,1,$4,'feed',now()-interval '8 minutes')`,
    [uid(1),evaluationPage.items[i].id,i===0?'like':'view',evaluationPage.items[i].exposure_id]);
  let replay = await replayExport();
  assert.equal(replay.slates.length,1); checks++;
  assert.equal(replay.observation_seconds,300); checks++;
  assert.deepEqual(replay.slates[0].items.map(p=>p.post_id),evaluationPage.items.map(p=>p.id)); checks++;
  assert.ok(replay.slates[0].items[0].signals.includes('like')); checks++;
  assert.deepEqual(replay.slates[0].items[7].signals,[]); checks++; // Loaded != viewed != disliked.
  assert.equal(Object.hasOwn(replay.slates[0].items[0],'body'),false); checks++;
  await db.query("UPDATE user_feed_preferences SET feed_algorithm='chronological' WHERE user_id=$1",[uid(1)]);
  assert.equal((await replayExport()).slates[0].mode,'smart'); checks++; // Frozen policy, not today's preference.
  await db.query(`INSERT INTO ml_interactions(user_id,post_id,signal_type,weight,exposure_id,surface)
    VALUES($1,$2,'hide',-3,$3,'feed')`,[uid(1),evaluationPage.items[0].id,evaluationPage.items[0].exposure_id]);
  assert.ok(!(await replayExport()).slates[0].items[0].signals.includes('hide')); checks++; // Outside fixed observation window.
  const creator = evaluationPage.items[0].user_id;
  for(const column of ['analytics_enabled','ai_personalization_enabled']) {
    await db.query(`UPDATE privacy_settings SET ${column}=false WHERE user_id=$1`,[uid(1)]);
    assert.equal((await replayExport()).slates.length,0); checks++;
    await db.query(`UPDATE privacy_settings SET ${column}=true WHERE user_id=$1`,[uid(1)]);
  }
  await db.query("UPDATE privacy_settings SET ai_data_sharing_enabled=false WHERE user_id=$1",[creator]);
  assert.equal((await replayExport()).slates.length,0); checks++;
  await db.query("UPDATE privacy_settings SET ai_data_sharing_enabled=true,profile_visibility='private' WHERE user_id=$1",[creator]);
  assert.equal((await replayExport()).slates.length,0); checks++;
  await db.query("UPDATE privacy_settings SET profile_visibility='public' WHERE user_id=$1",[creator]);
  await db.query('INSERT INTO user_message_blocks VALUES($1,$2)',[creator,uid(1)]);
  assert.equal((await replayExport()).slates.length,0); checks++;
  await db.query('DELETE FROM user_message_blocks WHERE blocker_user_id=$1 AND blocked_user_id=$2',[creator,uid(1)]);
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','feed_evaluation_slates(integer,timestamptz)','EXECUTE')"),false); checks++;
  assert.equal(await scalar("SELECT has_function_privilege('anon','feed_evaluation_slates(integer,timestamptz)','EXECUTE')"),false); checks++;
  assert.equal(await scalar("SELECT has_function_privilege('service_role','feed_evaluation_slates(integer,timestamptz)','EXECUTE')"),true); checks++;
  await assert.rejects(()=>db.query("SELECT feed_evaluation_slates(50,now()+interval '1 second')"),/invalid evaluation time/); checks++;
  await db.query("UPDATE feed_rank_snapshots SET expires_at=now()-interval '1 second' WHERE id=$1",[evaluationSnapshot]);
  assert.equal((await replayExport()).slates.length,0); checks++;
  console.log(`Feed SQL: ${checks} functional checks passed (isolated PostgreSQL).`);
} catch (error) {
  console.error(error.message, error.detail ?? '', error.where ?? '');
  process.exitCode = 1;
} finally { await db.close(); }
