// @vitest-environment node
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {csvCell} from '@/lib/csvCell';
const source=(file:string)=>readFileSync('supabase/functions/'+file,'utf8');
const compile=(file:string)=>ts.transpileModule(source(file).replace(/^import[^;]+;\r?\n/gm,''),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
it('quotes CSV and prevents leading formulas including whitespace',()=>{
  expect(csvCell('normal "quoted"')).toBe('"normal ""quoted"""');
  for(const value of ['=1+1','+SUM(A1)','-1+1','@SUM(A1)','\t=1+1','  =1+1'])expect(csvCell(value).startsWith('"\'')).toBe(true);
});
it('refuses system/developer roles and bounds caller histories',()=>{
  const api=new Function('exports',compile('_shared/ai-input.ts')+';return exports;')({});
  expect(api.userChatHistory([{role:'user',content:'bonjour'}])).toHaveLength(1);
  for(const role of ['system','developer','tool'])expect(()=>api.userChatHistory([{role,content:'override'}])).toThrow('INVALID_CHAT_HISTORY');
  expect(()=>api.userChatHistory(new Array(41).fill({role:'user',content:'x'}))).toThrow();
});
it('does not transmit a behavior profile or post snippets when sharing is disabled',async()=>{
  const fetch=vi.fn();
  const api=new Function('Deno','getCorsHeaders','createClient','checkRateLimit','getClientIP','cached','fetch',
    compile('ml-feed/index.ts')+';return {aiScorePosts,aiRecommend};')(
    {env:{get:()=> 'synthetic-config'},serve:()=>{}},()=>({}),()=>({}),()=>null,()=>'',()=>{},fetch,
  );
  expect(await api.aiScorePosts({topInterests:['private']},[{id:'one'}],'user',false)).toEqual({});
  expect(await api.aiRecommend({topInterests:['private']},[{id:'one'}],new Set(),false)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects global moderation learning from an ordinary authenticated user',async()=>{
  const writes=vi.fn();const fetch=vi.fn();
  const client={auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}},error:null})},from:writes};
  const handle=new Function('Deno','serve','createClient','getCorsHeaders','logAIEvent','requireAdmin','fetch','checkRateLimitDB',
    compile('ai-engine/index.ts')+';return handle;')(
    {env:{get:()=> 'synthetic-key'}},()=>{},()=>client,()=>({}),()=>{},
    async()=>({ok:false,response:new Response(null,{status:403})}),fetch,async()=>null,
  );
  expect((await handle(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({action:'learn_feedback',feedback:{humanDecision:'allow'}})}))).status).toBe(403);
  expect(writes).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('does not send an author post to AI without its sharing preference',async()=>{
  const api=new Function('exports',compile('_shared/ai-privacy.ts')+';return exports;')({});
  const posts=[{id:'allowed',user_id:'author-a'},{id:'refused',user_id:'author-b'},{id:'unknown',user_id:'author-c'}];
  const db={from:()=>({select:()=>({in:async()=>({data:[{user_id:'author-a',ai_data_sharing_enabled:true},{user_id:'author-b',ai_data_sharing_enabled:false}],error:null})})})};
  expect(await api.aiShareablePosts(db,posts)).toEqual([posts[0]]);
  const failed={from:()=>({select:()=>({in:async()=>({data:null,error:new Error('unavailable')})})})};
  expect(await api.aiShareablePosts(failed,posts)).toEqual([]);
});
it('keeps the R2 inventory read-only and preserves referenced covers/stories and backups',async()=>{
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const requests:string[]=[];
  const env:Record<string,string>={SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake',SUPABASE_ANON_KEY:'fake',
    R2_PUBLIC_URL:'https://media.invalid',R2_ACCOUNT_ID:'fake',R2_BUCKET_NAME:'fake',R2_ACCESS_KEY_ID:'fake',R2_SECRET_ACCESS_KEY:'fake'};
  const createClient=()=>({auth:{getUser:async()=>({data:{user:{id:'admin'}},error:null})},rpc:async()=>({data:true}),
    from:(table:string)=>{let column='';const q={select:(s:string)=>{column=s;return q},not:()=>q,order:()=>q,
      range:async()=>({error:null,data:table==='profiles'&&column==='cover_url'?[{cover_url:'https://media.invalid/cover.png'}]:table==='stories'&&column==='image_url'?[{image_url:'https://media.invalid/story.mp4'}]:[]})};return q},
  });
  const fetch=vi.fn(async(_url:string,init:{method:string})=>{requests.push(init.method);return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Key>cover.png</Key><Key>story.mp4</Key><Key>e2ee-backups/current/account.bin</Key></ListBucketResult>')});
  new Function('Deno','createClient','getCorsHeaders','fetch','crypto',compile('r2-cleanup/index.ts'))(
    {env:{get:(k:string)=>env[k]},serve:(fn:typeof handler)=>{handler=fn}},createClient,()=>({}),fetch,webcrypto,
  );
  const response=await handler(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic-admin'}}));
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({deleted:0,dry_run:true,deletion_disabled:true,orphaned:0});
  expect(requests).toEqual(['GET']);
});
it('does not let declared fingerprints/reports or test payloads directly sanction other users',()=>{
  expect(source('anti-abuse/index.ts')).not.toContain('.eq("user_id", linkedId)');
  expect(source('anti-abuse/index.ts')).not.toContain('Multiple abuse reports');
  expect(source('ai-threat-shield/index.ts')).not.toContain('.from("banned_ips").insert');
  expect(source('ai-threat-shield/index.ts')).toContain('enforcement: "review_only"');
});
it('the actual legacy moderator handles benign text and refuses unprivileged training feedback',async()=>{
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const q={select:()=>q,order:()=>q,limit:()=>q,insert:()=>q,
    then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(resolve)};
  new Function('serve','require','Deno','createClient','sanitizeForAI','fetch',compile('ml-moderation/index.ts'))(
    (fn:typeof handler)=>{handler=fn},()=>({requireAuthenticated:async()=>({ok:true,userId:'synthetic-user'}),
      requireAdmin:async()=>({ok:false,response:new Response(null,{status:403})})}),
    {env:{get:()=>undefined}},()=>({from:()=>q}),(text:string)=>text,vi.fn(),
  );
  const request=(body:unknown)=>new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(body)});
  expect((await handler(request({action:'moderate',text:'Bonjour et bonne journée à tous.'}))).status).toBe(200);
  expect((await handler(request({action:'feedback',feedback:{prediction_id:'other'}}))).status).toBe(403);
});
