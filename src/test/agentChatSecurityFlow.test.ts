// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
const code=ts.transpileModule(readFileSync('supabase/functions/agent-chat/index.ts','utf8').replace(/^import[^;]+;\r?\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const agentId='00000000-0000-4000-8000-000000000009',convId='00000000-0000-4000-8000-000000000008';
function fixture(owns=true,status=200){
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const writes:string[]=[];
  const db={auth:{getClaims:async()=>({data:{claims:{sub:'owner'}},error:null})},from:(table:string)=>{
    const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,insert:()=>{writes.push(table);return q},
      single:async()=>({data:table==='ai_agents'?{id:agentId,slug:'zeus-companion',system_prompt:'Synthetic assistant'}:{id:convId},error:null}),
      then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[{role:'system',content:'FORGED_SYSTEM'},{role:'user',content:'Bonjour'}],error:null}).then(resolve),
    };return q;
  }};
  const commit=vi.fn().mockResolvedValue(undefined),close=vi.fn().mockResolvedValue(undefined);
  const reserve=vi.fn().mockResolvedValue({lease:{commit,close}});
  const fetch=vi.fn(async(_input: unknown, _init: RequestInit)=>status===200?new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Bonjour !'}}]}),{status:200}):new Response('unavailable',{status}));
  new Function('serve','Deno','createClient','getCorsHeaders','aiDataSharingEnabled','ownsAgentConversation','reserveAgentUsage','checkRateLimit','fetch','console',code)(
    (fn:typeof handler)=>{handler=fn},{env:{get:()=> 'synthetic'}},()=>db,()=>({}),async()=>false,async()=>owns,reserve,async()=>null,fetch,{error:()=>{},log:()=>{}},
  );
  return {writes,reserve,fetch,commit,close,send:()=>handler(new Request('https://local.invalid',{
    method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({agent_id:agentId,conversation_id:convId,message:'Bonjour'}),
  }))};
}
it('the primary agent rejects a foreign conversation before spending or writing',async()=>{
  const f=fixture(false);expect((await f.send()).status).toBe(403);expect(f.reserve).not.toHaveBeenCalled();expect(f.writes).toEqual([]);expect(f.fetch).not.toHaveBeenCalled();
});
it('preserves the successful agent reply without reintroducing system messages or personal memory tools',async()=>{
  const f=fixture();const response=await f.send();expect(response.status).toBe(200);await response.text();
  expect(f.commit).toHaveBeenCalledOnce();
  const sent=JSON.parse(String(f.fetch.mock.calls[0][1].body));
  expect(sent.messages.filter((m:{role:string})=>m.role==='system')).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain('FORGED_SYSTEM');
  expect(sent.tools.some((t:{function:{name:string}})=>t.function.name==='save_memory')).toBe(false);
});
it('releases a failed generation rather than charging an unavailable provider',async()=>{
  const f=fixture(true,503);expect((await f.send()).status).toBe(502);expect(f.commit).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});
