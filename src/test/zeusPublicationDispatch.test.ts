// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect,it,vi } from 'vitest';
const source=ts.transpileModule(readFileSync('supabase/functions/agent-actions/index.ts','utf8').replace(/^import[^;]+;\r?\n/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(allowed:boolean,dispatched:boolean){
  const insert=vi.fn();const rpc=vi.fn(async(name:string)=>({data:name==='zeus_capability_state'?{allowed}:dispatched,error:null}));
  const db={auth:{getUser:async()=>({data:{user:{id:'11111111-1111-4111-8111-111111111111'}}})},rpc,from:()=>{
    const q={insert:(value:unknown)=>{insert(value);return q;},select:()=>q,single:async()=>({data:{id:'22222222-2222-4222-8222-222222222222'},error:null})};return q;
  }};
  let handle!:(req:Request)=>Promise<Response>;
  new Function('serve','createClient','getCorsHeaders','zeusCommandFingerprint','Deno','exports',source)((fn:typeof handle)=>{handle=fn;},()=>db,()=>({}),async()=>'fingerprint',{env:{get:()=> 'synthetic'}},{});
  const send=(type='publish_post')=>handle(new Request('https://synthetic.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({action:{type,body:'Texte'},command_key:'command'})}));
  return {send,insert,rpc};
}
it('rejects a disabled publication capability before writing a post',async()=>{
  const f=fixture(false,true);expect((await f.send()).status).toBe(403);expect(f.insert).not.toHaveBeenCalled();
});
it.each(['schedule_post','create_story','generate_image'])('also enforces the content capability for the legacy %s action',async type=>{
  const f=fixture(false,true);expect((await f.send(type)).status).toBe(403);expect(f.insert).not.toHaveBeenCalled();
});
it('rejects an already dispatched or unconfirmed publication before writing a post',async()=>{
  const f=fixture(true,false);expect((await f.send()).status).toBe(409);expect(f.insert).not.toHaveBeenCalled();
});
it('publishes only after the server dispatch fence confirms its reservation',async()=>{
  const f=fixture(true,true);const response=await f.send();expect(response.status).toBe(200);expect(f.insert).toHaveBeenCalledOnce();
  expect(f.rpc).toHaveBeenCalledWith('zeus_dispatch_post_command',{p_key:'command',p_fingerprint:'fingerprint'});
  expect(await response.json()).toMatchObject({success:true,post_id:'22222222-2222-4222-8222-222222222222'});
});
