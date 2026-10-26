// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
const source=readFileSync('supabase/functions/cleanup-unconfirmed/index.ts','utf8');
const code=ts.transpileModule(source.replace(/^import[^;]+;\r?\n/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const user={id:'synthetic',created_at:'2025-01-01T00:00:00Z'};
function fixture(pages:unknown[][],fresh:unknown=user,fail=false){
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const list=vi.fn(async({page}:{page:number})=>({data:{users:pages[page-1]??[]},error:null}));
  const get=vi.fn(async()=>({data:{user:fresh},error:fail?new Error('synthetic'):null}));
  const deleted=vi.fn();
  new Function('Deno','createClient','corsHeaders','requireCronSecret','requireAdmin','console',code)(
    {serve:(fn:typeof handler)=>{handler=fn},env:{get:()=> 'synthetic'}},
    ()=>({auth:{admin:{listUsers:list,getUserById:get,deleteUser:deleted}},from:()=>({delete:deleted})}),{},()=>({ok:true}),async()=>({ok:true}),{log:()=>{},error:()=>{}},
  );
  return {list,get,deleted,send:()=>handler(new Request('https://local.invalid',{method:'POST'}))};
}
it('never destroys a profile/account while reviewing unconfirmed registrations',async()=>{
  const f=fixture([[user]]);const response=await f.send();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({mode:'review_only',deletion_enabled:false,deleted:0,total_unconfirmed:1,complete:true});
  expect(f.deleted).not.toHaveBeenCalled();expect(source).not.toContain('.delete()');expect(source).not.toContain('.deleteUser(');
});
it('excludes a confirmation occurring between the inventory and the authority recheck',async()=>{
  const f=fixture([[user]],{...user,email_confirmed_at:new Date().toISOString()});
  expect((await (await f.send()).json()).total_unconfirmed).toBe(0);expect(f.deleted).not.toHaveBeenCalled();
});
it('paginates beyond 500 entries and does not treat OAuth/phone/active accounts as abandoned',async()=>{
  const page=Array.from({length:500},(_,i)=>({...user,id:String(i),last_sign_in_at:'2026-01-01'}));
  const f=fixture([page,[{...user,id:'phone',phone_confirmed_at:'2026-01-01'},user]]);
  expect((await (await f.send()).json()).scanned).toBe(502);expect(f.list.mock.calls.map(x=>x[0].page)).toEqual([1,2]);expect(f.get).toHaveBeenCalledOnce();
});
it('fails without publishing a successful review if the fresh Auth read fails',async()=>{
  const f=fixture([[user]],null,true);expect((await f.send()).status).toBe(500);expect(f.deleted).not.toHaveBeenCalled();
});
