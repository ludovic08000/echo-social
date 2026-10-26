import handler from '../functions/_shared/generated/mcp-handler.mjs';
import { boundedMcpRequest } from '../functions/_shared/mcp-request.ts';

Deno.env.delete('LOVABLE_API_KEY'); // Aucune télémétrie réseau pendant les fixtures.

Deno.test('isolated generated runtime boots in Deno and rejects unauthenticated tool requests', async () => {
  for (const path of ['/functions/v1/mcp','/functions/v1/mcp/.mcp/list-tools','/functions/v1/mcp/.mcp/invoke-tool/get-my-profile']) {
    const response=await handler(new Request('https://project.invalid'+path,{
      method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),
    }));
    if(response.status!==401)throw new Error(`Expected 401, got ${response.status}`);
    await response.text();
  }
});
Deno.test('the function body bound also works under the real Deno Web APIs',async()=>{
  const result=await boundedMcpRequest(new Request('https://project.invalid',{method:'POST',body:new Uint8Array(1_048_577)}));
  if(!(result instanceof Response)||result.status!==413)throw new Error('Missing body bound');
  await result.text();
});

Deno.test('real Deno OAuth verifies issuer/audience/expiry and preserves the caller-scoped profile RPC',async()=>{
  const issuer='https://vkpmoqfzrihcijjochks.supabase.co/auth/v1';
  const user='00000000-0000-4000-8000-000000000002';
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair;
  const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'synthetic-test-key',alg:'ES256',use:'sig'};
  const b64=(value:Uint8Array)=>btoa(String.fromCharCode(...value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const encode=(value:unknown)=>b64(new TextEncoder().encode(JSON.stringify(value)));
  const jwt=async(changed:Record<string,unknown>={})=>{
    const header=encode({alg:'ES256',kid:jwk.kid,typ:'JWT'});
    const payload=encode({iss:issuer,aud:'authenticated',sub:user,client_id:'synthetic-client',role:'authenticated',
      exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000),...changed});
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(header+'.'+payload));
    return header+'.'+payload+'.'+b64(new Uint8Array(signature));
  };
  Deno.env.set('SUPABASE_URL','https://project.invalid');
  Deno.env.set('SUPABASE_ANON_KEY','synthetic-public-key');
  Deno.env.delete('SUPABASE_PUBLISHABLE_KEY');
  const originalFetch=globalThis.fetch;
  let calls=0;let expectedToken='';
  globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=input instanceof Request?input:new Request(input,init);
    if(request.url==='https://vkpmoqfzrihcijjochks.supabase.co/.well-known/oauth-authorization-server/auth/v1')
      return new Response(JSON.stringify({issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',
        jwks_uri:issuer+'/.well-known/jwks.json',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
        code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']}),{headers:{'Content-Type':'application/json'}});
    if(request.url===issuer+'/.well-known/jwks.json')return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
    if(request.url==='https://project.invalid/rest/v1/rpc/get_profile_for_viewer'){
      calls++;
      if(request.headers.get('authorization')!=='Bearer '+expectedToken)throw new Error('Caller JWT was replaced');
      if((await request.json()).p_user_id!==user)throw new Error('RPC user was replaced');
      return new Response(JSON.stringify({user_id:user,name:'Synthetic profile'}),{headers:{'Content-Type':'application/json'}});
    }
    throw new Error('Unexpected network destination');
  };
  try {
    const invoke=async(token:string)=>handler(new Request('https://project.invalid/functions/v1/mcp/.mcp/invoke-tool/get_my_profile',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',
    }));
    for(const invalid of [{iss:'https://wrong.invalid/auth/v1'},{aud:'other-service'},{exp:1}]){
      const response=await invoke(await jwt(invalid));
      if(response.status!==401)throw new Error('Invalid OAuth token was not rejected: '+response.status);
      await response.text();
    }
    if(calls!==0)throw new Error('Invalid token reached the data RPC');
    expectedToken=await jwt();
    const response=await invoke(expectedToken);
    if(response.status!==200)throw new Error('Valid OAuth request failed: '+response.status+' '+await response.text());
    const result=await response.json();
    if(result.structuredContent?.profile?.user_id!==user||Number(calls)!==1)throw new Error('Successful profile path changed');
  } finally {
    globalThis.fetch=originalFetch;
    Deno.env.delete('SUPABASE_URL');Deno.env.delete('SUPABASE_ANON_KEY');
  }
});
