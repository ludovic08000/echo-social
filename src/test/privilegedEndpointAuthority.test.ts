// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
const transpile=(file:string)=>ts.transpileModule(readFileSync(file,'utf8').replace(/^import[^;]+;\r?\n/gm,''),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const pushApi=new Function('exports',transpile('supabase/functions/_shared/push-endpoint.ts')+';return exports;')({});
it.each(['https://fcm.googleapis.com/fcm/send/one','https://web.push.apple.com/Qone',
  'https://updates.push.services.mozilla.com/wpush/v2/one','https://wns2-par02p.notify.windows.com/w/?token'])('allows a real provider family: %s',url=>{
  expect(pushApi.allowedPushEndpoint(url)?.href).toBe(url);
});
it.each(['http://fcm.googleapis.com/send','https://127.0.0.1/','https://[::1]/','https://169.254.169.254/',
  'https://attacker.invalid/push','https://fcm.googleapis.com.evil.invalid/','https://fcm.googleapis.com:8443/',
  'https://user:pass@fcm.googleapis.com/','https://evil.invalid@fcm.googleapis.com/','file:///etc/passwd'])('rejects arbitrary destinations: %s',url=>{
  expect(pushApi.allowedPushEndpoint(url)).toBeNull();
});
it('does not follow push-provider redirects and uses a deadline',()=>{
  const source=readFileSync('supabase/functions/push-notify/index.ts','utf8');
  expect(source).toContain('allowedPushEndpoint(subscription.endpoint)');
  expect(source).toContain('redirect: "error"');expect(source).toContain('AbortSignal.timeout(10_000)');
});
it('refuses an unprivileged cleanup before creating any service client',async()=>{
  let handle:(req:Request)=>Promise<Response>=async()=>new Response();
  const createClient=vi.fn();
  new Function('Deno','createClient','corsHeaders','requireCronSecret','requireAdmin',transpile('supabase/functions/cleanup-unconfirmed/index.ts'))(
    {serve:(fn:typeof handle)=>{handle=fn},env:{get:()=>undefined}},createClient,{},()=>({ok:false}),
    async()=>({ok:false,response:new Response(null,{status:403})}),
  );
  expect((await handle(new Request('https://local.invalid',{method:'POST'}))).status).toBe(403);
  expect(createClient).not.toHaveBeenCalled();
});
it('routes both message request APIs through the JWT-scoped decision, never plaintext moderation',()=>{
  const zeus=readFileSync('supabase/functions/zeus/index.ts','utf8');
  const moderation=readFileSync('supabase/functions/message-moderation/index.ts','utf8');
  expect(zeus).toContain('case "moderation": __resp = await decideMessageRequest(req, body, cors)');
  expect(zeus).not.toContain('async function handleModeration(');
  expect(moderation).toContain('return decideMessageRequest(req,request,corsHeaders)');
  expect(moderation).not.toContain('.update({ status: nextStatus })');
});
