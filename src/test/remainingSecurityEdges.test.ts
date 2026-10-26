// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
const compile=(file:string)=>ts.transpileModule(readFileSync('supabase/functions/'+file,'utf8').replace(/^import[^;]+;\r?\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const authority=new Function('exports',compile('_shared/ai-agent-authority.ts')+';return exports;')({});
it('binds a conversation to both user and agent before any history is read',async()=>{
  const filters:unknown[]=[];
  const q={select:()=>q,eq:(key:string,value:string)=>{filters.push([key,value]);return q},maybeSingle:async()=>({data:null,error:null})};
  expect(await authority.ownsAgentConversation({from:()=>q},'owner','agent','foreign')).toBe(false);
  expect(filters).toEqual([['id','foreign'],['user_id','owner'],['agent_id','agent']]);
});
it('does not charge twice or release a committed quota reservation',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:{allowed:true},error:null}).mockResolvedValue({data:true,error:null});
  const {lease}=await authority.reserveAgentUsage({rpc},'owner','agent',{});
  await lease.commit();await lease.commit();await lease.close();
  expect(rpc).toHaveBeenCalledTimes(2);expect(rpc.mock.calls[1][1].p_success).toBe(true);
});
it('denies unavailable quota authority and releases an uncommitted attempt',async()=>{
  const denied=await authority.reserveAgentUsage({rpc:async()=>({data:null,error:new Error('offline')})},'owner','agent',{});
  expect(denied.denial.status).toBe(503);
  const rpc=vi.fn().mockResolvedValueOnce({data:{allowed:true},error:null}).mockResolvedValue({data:true,error:null});
  const {lease}=await authority.reserveAgentUsage({rpc},'owner','agent',{});
  await lease.close();await lease.close();expect(rpc.mock.calls[1][1].p_success).toBe(false);expect(rpc).toHaveBeenCalledTimes(2);
});
function loginFixture(userEmail='owner@example.invalid'){
  let handle:(req:Request)=>Promise<Response>=async()=>new Response();const rpc=vi.fn().mockResolvedValue({data:{allowed:true},error:null});
  const client={rpc,auth:{getUser:async()=>({data:{user:{id:'owner',email:userEmail}},error:null})}};
  new Function('Deno','createClient','getCorsHeaders',compile('login-rate-limit/index.ts'))(
    {env:{get:()=> 'synthetic'},serve:(fn:typeof handle)=>{handle=fn}},()=>client,()=>({}),
  );
  return {rpc,request:(success:boolean,email='owner@example.invalid',authenticated=false)=>handle(new Request('https://local.invalid',{
    method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer verified'}:{})},
    body:JSON.stringify({action:'record',email,success}),
  }))};
}
it('never records an unauthenticated browser declaration as an Auth failure or success',async()=>{
  const f=loginFixture();expect((await f.request(false)).status).toBe(202);expect((await f.request(true)).status).toBe(401);expect(f.rpc).not.toHaveBeenCalled();
});
it('records success only for the server-verified Auth account and not another email',async()=>{
  const f=loginFixture();expect((await f.request(true,'other@example.invalid',true)).status).toBe(403);expect(f.rpc).not.toHaveBeenCalled();
  expect((await f.request(true,'owner@example.invalid',true)).status).toBe(200);
  expect(f.rpc.mock.calls[0][1]).toMatchObject({p_success:true});
  expect(JSON.stringify(f.rpc.mock.calls[0][1])).not.toContain('owner@example.invalid');
});
it('rechecks external training consent, dates and subscriber-only eligibility against current rows',async()=>{
  const privacy=new Function('exports',compile('_shared/ai-privacy.ts')+';return exports;')({});
  const posts=[{id:'public',user_id:'owner'},{id:'subscriber',user_id:'owner'},{id:'refused',user_id:'other'},{id:'gone',user_id:'owner'}];
  const db={from:(table:string)=>({select:()=>({in:async()=>table==='posts'?{data:[{...posts[0]},{...posts[1],subscriber_only:true},{...posts[2]}],error:null}:{data:[
    {user_id:'owner',ai_data_sharing_enabled:true,ai_personalization_enabled:true,profile_visibility:'public',posts_visibility:'public'},
    {user_id:'other',ai_data_sharing_enabled:false,ai_personalization_enabled:true,profile_visibility:'public',posts_visibility:'public'},
  ],error:null}})})};
  expect(await privacy.publicTrainingPosts(db,posts)).toEqual([posts[0]]);
});
it('the actual legacy Zeus agent refuses a foreign conversation before writes, quota or AI calls',async()=>{
  const fetch=vi.fn();const reserve=vi.fn();const writes=vi.fn();
  const db={from:()=>({select:()=>({eq:()=>({eq:()=>({single:async()=>({data:{id:'agent'},error:null})})})}),insert:writes})};
  const handle=new Function('Deno','createClient','getCorsHeaders','ownsAgentConversation','reserveAgentUsage','fetch',
    compile('zeus/index.ts')+';return handleAgentChat;')({env:{get:()=>undefined},serve:()=>{}},()=>({}),()=>({}),async()=>false,reserve,fetch);
  const result=await handle('synthetic',{agent_id:'agent',conversation_id:'foreign',message:'Bonjour'},'user',db,{});
  expect(result.status).toBe(403);expect(writes).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
