// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {beforeAll,expect,it,vi} from 'vitest';
import {assertPublishedSigningKeyMatches,validateTransparencySigningKey} from '../../supabase/functions/_shared/kt-signing-key';
let serialized:string;let pub:JsonWebKey;
const code=ts.transpileModule(readFileSync('supabase/functions/kt-publish-epoch/index.ts','utf8').replace(/^import[^;]+;\r?\n/gm,''),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
beforeAll(async()=>{
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
  pub=await crypto.subtle.exportKey('jwk',pair.publicKey);
  serialized=JSON.stringify({priv:await crypto.subtle.exportKey('jwk',pair.privateKey),pub});
});
function fixture(committed:unknown=true,race=false,previousError=false){
  let handler:(request:Request)=>Promise<Response>=async()=>new Response();
  const writes=vi.fn();const rpc=vi.fn(async()=>({data:committed,error:race?{code:'40001'}:null}));
  const db={rpc,from:(table:string)=>{
    const q={select:()=>q,is:()=>q,eq:()=>q,order:()=>q,limit:()=>q,insert:(value:unknown)=>{writes(value);return q},
      maybeSingle:async()=>({data:table==='e2ee_kt_signing_keys'?{id:'key',public_key_jwk:pub}:null,error:previousError&&table==='e2ee_kt_tree_heads'?new Error('unavailable'):null}),
      then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[{id:1,user_id:'synthetic',event_type:'device_linked',created_at:'2026-10-18T00:00:00Z'}],error:null}).then(resolve),
    };return q;
  }};
  new Function('Deno','createClient','assertPublishedSigningKeyMatches','validateTransparencySigningKey','console',code)(
    {serve:(fn:typeof handler)=>{handler=fn},env:{get:(name:string)=>name==='KT_SIGNING_PRIV_JWK'?serialized:'synthetic'}},
    ()=>db,assertPublishedSigningKeyMatches,validateTransparencySigningKey,{error:()=>{}},
  );
  return {rpc,writes,send:()=>handler(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic'}}))};
}
it('publishes through one atomic RPC and confirms success only after a true server result',async()=>{
  const f=fixture();expect((await f.send()).status).toBe(200);expect(f.rpc).toHaveBeenCalledOnce();expect(f.writes).not.toHaveBeenCalled();
  const rejected=fixture(false);expect((await rejected.send()).status).toBe(500);
});
it('reports a publisher race as retryable without separate partial writes',async()=>{
  const f=fixture(false,true);const response=await f.send();expect(response.status).toBe(409);expect(await response.json()).toMatchObject({retryable:true});expect(f.writes).not.toHaveBeenCalled();
});
it('does not invent a genesis epoch after a failed previous-head lookup',async()=>{
  const f=fixture(true,false,true);expect((await f.send()).status).toBe(500);expect(f.rpc).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
});
