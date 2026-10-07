import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
export async function testNewsDiscussionsDatabase(db) {
  await db.exec('RESET ROLE');
  await db.exec(`CREATE TABLE abuse_reports(reporter_id uuid,reported_user_id uuid,report_type text,description text,evidence_urls text[]);
    CREATE FUNCTION has_role(uid uuid,role text) RETURNS boolean LANGUAGE sql AS $$ SELECT uid='00000000-0000-4000-8000-000000000809'::uuid AND role='admin' $$;`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261005225507_news_discussions_and_context.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261007211600_partner_media_thumbnails_and_inline_comments.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261007211800_partner_media_thumbnail_proxy.sql',import.meta.url),'utf8'));
  const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const q=(sql,args=[])=>db.query(sql,args);
  const scalar=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
  let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
  const rejects=async(sql,args=[],pattern=/permission denied/)=>{await assert.rejects(()=>q(sql,args),pattern);checks++;};
  const login=async n=>{await db.exec('RESET ROLE');await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);await db.exec('SET ROLE authenticated');};
  for(const n of [801,802,803,809]) {
    await q('INSERT INTO auth.users VALUES($1)',[id(n)]);
    await q("INSERT INTO profiles(user_id,date_of_birth,city) VALUES($1,$2,'Reims')",[id(n),n===803?'2015-01-01':'1990-01-01']);
  }
  await q(`INSERT INTO media_partners(id,name,website_host,region,agreement_reference,rights_until,active,allow_excerpt)
    VALUES($1,'Synthetic newspaper','news.invalid','Grand Est','fixture',now()+interval '5 days',true,true)`,[id(810)]);
  const insert=(n,url,moderated=true,family=true)=>q(`INSERT INTO partner_media_items(id,partner_id,external_id,title,canonical_url,kind,excerpt,published_at,expires_at,moderated,family_safe)
    VALUES($1,$2,$3,'Licensed title',$4,'article','Licensed excerpt',now()-interval '1 hour',now()+interval '1 day',$5,$6)`,[id(n),id(810),String(n),url,moderated,family]);
  await db.exec('SET ROLE service_role');
  await insert(811,'https://news.invalid/one');await insert(812,'https://news.invalid/one');
  await insert(813,'https://news.invalid/two',false);await insert(814,'https://news.invalid/adult',true,false);
  const importedRows=(await q(`SELECT external_id,title,excerpt,canonical_url,kind,youtube_id,published_at,expires_at
    FROM partner_media_items WHERE id IN ($1,$2) ORDER BY id`,[id(811),id(812)])).rows;
  const thumbnail='https://images.news.invalid/one.webp';
  for (const imported of importedRows) imported.thumbnail_url=thumbnail;
  eq(await scalar('SELECT import_partner_media($1,$2)',[id(810),JSON.stringify(importedRows)]),2);
  eq(await scalar('SELECT moderated FROM partner_media_items WHERE id=$1',[id(811)]),true);
  eq(await scalar('SELECT thumbnail_url FROM partner_media_items WHERE id=$1',[id(811)]),thumbnail);
  eq(await scalar('SELECT partner_media_thumbnail_source($1)',[id(811)]),thumbnail);
  const tid=await scalar('SELECT discussion_id FROM partner_media_items WHERE id=$1',[id(811)]);
  const adult=await scalar('SELECT discussion_id FROM partner_media_items WHERE id=$1',[id(814)]);
  eq(tid,await scalar('SELECT discussion_id FROM partner_media_items WHERE id=$1',[id(812)]));
  eq(null,await scalar('SELECT discussion_id FROM partner_media_items WHERE id=$1',[id(813)]));
  const read=(thread=tid,time=null,cursor=null)=>scalar('SELECT get_news_discussion($1,$2,$3)',[thread,time,cursor]);
  const add=(n,text='Hello',parent=null,thread=tid)=>scalar('SELECT add_news_comment($1,$2,$3,$4)',[thread,id(n),text,parent]);
  await login(801);eq((await read()).article.title,'Licensed title');eq((await read()).article.thumbnail_url,thumbnail);
  for(const table of ['news_threads','news_comments','news_comment_limits','news_comment_reports']) await rejects('SELECT * FROM '+table);
  await rejects('SELECT partner_media_thumbnail_source($1)',[id(811)]);
  await rejects('SELECT news_thread_readable($1,$2)',[tid,id(802)]);
  await rejects('SELECT partner_media_for_zone($1,$2,$3,$4,$5)',['france','all',null,null,null]);
  await rejects('INSERT INTO news_comments(id,thread_id,user_id,body) VALUES($1,$2,$3,$4)',[id(820),tid,id(802),'forged']);
  eq(await add(820),id(820));eq(await add(820),id(820)); // network retry is idempotent
  await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(820),'different'],/COMMENT_CONFLICT/);
  await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(821),'too fast'],/COMMENT_RATE_LIMITED/);
  await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(822),' '],/INVALID_COMMENT/);
  await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(822),'x'.repeat(1001)],/INVALID_COMMENT/);
  await login(802);eq(await add(821,'Reply',id(820)),id(821));
  await rejects('SELECT add_news_comment($1,$2,$3,$4)',[adult,id(822),'cross-thread',id(820)],/REPLY_UNAVAILABLE/);
  await rejects('SELECT add_news_comment($1,$2,$3,$4)',[tid,id(822),'too deep',id(821)],/REPLY_UNAVAILABLE/);
  eq(await scalar('SELECT remove_news_comment($1)',[id(820)]),false);
  eq(await scalar('SELECT report_news_comment($1,$2)',[id(820),'spam']),true);
  eq(await scalar('SELECT report_news_comment($1,$2)',[id(820),'spam']),false);
  await rejects('SELECT moderate_news_comment($1)',[id(820)],/ADMIN_REQUIRED/);
  await db.exec('RESET ROLE');eq(Number(await scalar('SELECT count(*) FROM abuse_reports')),1);
  await q('INSERT INTO user_message_blocks VALUES($1,$2)',[id(801),id(802)]);
  await login(802);eq((await read()).comments.length,0); // blocked root and its replies are hidden
  await rejects('SELECT add_news_comment($1,$2,$3,$4)',[tid,id(822),'blocked reply',id(820)],/REPLY_UNAVAILABLE/);
  await db.exec('RESET ROLE');await q('DELETE FROM user_message_blocks WHERE blocker_user_id=$1',[id(801)]);
  await login(801);eq(await scalar('SELECT remove_news_comment($1)',[id(820)]),true);
  eq((await read()).comments[0].body,'');eq((await read()).comments[1].body,'Reply');
  await login(809);eq(await scalar('SELECT moderate_news_comment($1)',[id(821)]),true);eq((await read()).comments[1].removed,true);
  await login(803);eq((await read(adult)).id,adult);eq((await read()).id,tid);
  // Keyset pagination does not skip ties or repeat rows; 51st row is only a sentinel.
  await db.exec('RESET ROLE');
  for(let n=830;n<886;n++) await q("INSERT INTO news_comments(id,thread_id,user_id,body,created_at) VALUES($1,$2,$3,'page',now()+interval '1 hour')",[id(n),tid,id(801)]);
  await login(801);const first=(await read()).comments;eq(first.length,51);
  const next=(await read(tid,first[49].created_at,first[49].id)).comments;
  eq(new Set([...first.slice(0,50),...next].map(x=>x.id)).size,58);
  await rejects('SELECT get_news_discussion($1,$2,$3)',[tid,first[0].created_at,null],/INVALID_CURSOR/);
  await login(802);
  for(let n=830;n<849;n++) await scalar('SELECT report_news_comment($1,$2)',[id(n),'spam']);
  await rejects('SELECT report_news_comment($1,$2)',[id(849),'spam'],/REPORT_RATE_LIMITED/);
  eq(await scalar('SELECT report_news_comment($1,$2)',[id(830),'spam']),false);
  await db.exec('RESET ROLE');eq(Number(await scalar('SELECT count(*) FROM news_comment_reports WHERE reporter_id=$1',[id(802)])),20);
  await login(801);
  // Coarse context never saves data; explicit opt-out wins over any client-supplied region.
  const context=()=>scalar("SELECT get_contextual_partner_media('nearby','all','FR','Grand Est','Reims')");
  eq((await context()).some(x=>x.discussion_id===tid),true);
  eq((await context()).find(x=>x.discussion_id===tid).thumbnail_url,thumbnail);
  eq(Number(await scalar('SELECT count(*) FROM discovery_preferences')),0);
  await scalar('SELECT set_discovery_preferences($1)',[JSON.stringify({local_media:false})]);
  eq((await context()).some(x=>x.discussion_id===tid),false);
  await scalar('SELECT set_discovery_preferences($1)',[JSON.stringify({local_media:true,country:'FR',region:'Bretagne',city:'Rennes'})]);
  eq((await context()).some(x=>x.discussion_id===tid),false); // manual region not overwritten
  await db.exec('RESET ROLE');
  // Expiring RSS deletes neither the thread nor the member discussions, and exposes no expired excerpts.
  await q('DELETE FROM partner_media_items WHERE id IN ($1,$2)',[id(811),id(812)]);
  await login(801);eq((await read()).article,null);eq((await read()).comments.length,51);
  await login(803);eq((await read()).id,tid);
  await db.exec('RESET ROLE');await q('UPDATE news_threads SET locked=true WHERE id=$1',[tid]);
  await login(802);await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(889),'locked'],/DISCUSSION_UNAVAILABLE/);
  await db.exec('RESET ROLE');await q('DELETE FROM auth.users WHERE id=$1',[id(801)]);
  eq(Number(await scalar('SELECT count(*) FROM news_comments WHERE thread_id=$1 AND user_id IS NULL AND body<>$2',[tid,''])),0);
  eq(Number(await scalar('SELECT count(*) FROM news_comments WHERE thread_id=$1',[tid])),58);
  await login(null);eq(await read(),null);await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(889),'unauth'],/AUTH_REQUIRED/);
  await db.exec('SET ROLE anon');await rejects('SELECT get_news_discussion($1)',[tid]);await rejects('SELECT add_news_comment($1,$2,$3)',[tid,id(890),'anon']);
  console.log(`News discussions SQL: ${checks} functional checks passed (authorization, blocking, moderation, idempotency, paging, rights expiry and context opt-out).`);
}
