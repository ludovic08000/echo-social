// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
const env={env:{get:()=> 'synthetic-config'}};
const code=(file:string)=>ts.transpileModule(readFileSync(`supabase/functions/${file}`,'utf8').replace(/^import[^;]+;\r?\n/gm,''),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const policy=new Function('Deno','exports',code('_shared/payment-authority.ts')+';return exports;')({env:{get:()=>undefined}},{});
const price={id:policy.DEFAULT_CREATOR_PRICE_ID,active:true,currency:'eur',unit_amount:499,recurring:{interval:'month',interval_count:1}};
const user={id:'synthetic-buyer',email:'buyer@example.invalid'};
const quiet={log:()=>{},warn:()=>{},error:()=>{}};
it('actual checkout rejects another active price before creating a session',async()=>{
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const create=vi.fn();const retrieve=vi.fn();
  function Stripe(){return {prices:{retrieve},checkout:{sessions:{create}}}}
  new Function('serve','Stripe','createClient','getCorsHeaders','ddosShield','creatorPlanForPrice','creatorPriceId','CREATOR_PLANS','paymentReturnOrigin','Deno',code('create-checkout/index.ts'))(
    (fn:typeof handler)=>{handler=fn},Stripe,()=>({auth:{getUser:async()=>({data:{user},error:null})}}),()=>({}),async()=>null,
    policy.creatorPlanForPrice,policy.creatorPriceId,policy.CREATOR_PLANS,policy.paymentReturnOrigin,env,
  );
  const response=await handler(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({plan:'creator_unknown'})}));
  expect(response.status).toBe(400);expect(create).not.toHaveBeenCalled();expect(retrieve).not.toHaveBeenCalled();
});
it('actual checkout binds the correct plan and buyer to server metadata and trusted return URLs',async()=>{
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const create=vi.fn().mockResolvedValue({url:'https://checkout.stripe.com/synthetic'});
  function Stripe(){return {prices:{retrieve:async()=>price},customers:{list:async()=>({data:[]})},checkout:{sessions:{create}}}}
  new Function('serve','Stripe','createClient','getCorsHeaders','ddosShield','creatorPlanForPrice','creatorPriceId','CREATOR_PLANS','paymentReturnOrigin','Deno',code('create-checkout/index.ts'))(
    (fn:typeof handler)=>{handler=fn},Stripe,()=>({auth:{getUser:async()=>({data:{user},error:null})}}),()=>({}),async()=>null,
    policy.creatorPlanForPrice,policy.creatorPriceId,policy.CREATOR_PLANS,policy.paymentReturnOrigin,env,
  );
  const response=await handler(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json',Origin:'https://evil.invalid'},body:JSON.stringify({plan:'creator_essential'})}));
  expect(response.status).toBe(200);
  expect(create.mock.calls[0][0]).toMatchObject({client_reference_id:user.id,metadata:{type:'creator_subscription',user_id:user.id,plan:'creator_essential'},success_url:'https://forsure.fans/creator?success=true'});
});
async function webhookFixture(validPrice:boolean,writeError=false){
  let handler:(req:Request)=>Promise<Response>=async()=>new Response();
  const writes:{table:string;operation:string}[]=[];
  const client={rpc:async()=>({data:true,error:null}),from:(table:string)=>{
    const q={update:()=>{writes.push({table,operation:'update'});return q},upsert:()=>{writes.push({table,operation:'upsert'});return q},
      delete:()=>{writes.push({table,operation:'delete'});return q},eq:()=>q,
      then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[],error:writeError&&table==='creator_subscriptions'?new Error('DB unavailable'):null}).then(resolve)};return q;
  }};
  const session={mode:'subscription',payment_status:'paid',subscription:'sub_synthetic',customer:'cus_synthetic',metadata:{type:'creator_subscription',user_id:user.id}};
  function Stripe(){return {webhooks:{constructEvent:()=>({id:'evt_synthetic',type:'checkout.session.completed',data:{object:session}})},
    subscriptions:{retrieve:async()=>({status:'active',current_period_start:1_700_000_000,current_period_end:1_702_592_000,items:{data:[{quantity:1,price:validPrice?price:{...price,id:'price_cheaper_fan',unit_amount:199}}]}})}}}
  new Function('serve','Stripe','createClient','getCorsHeaders','creatorPlanForPrice','CREATOR_PLANS','settleMarketplacePayment','Deno','console',code('stripe-webhook/index.ts'))(
    (fn:typeof handler)=>{handler=fn},Stripe,()=>client,()=>({}),policy.creatorPlanForPrice,policy.CREATOR_PLANS,vi.fn(),env,quiet,
  );
  const response=await handler(new Request('https://local.invalid',{method:'POST',headers:{'stripe-signature':'synthetic-signature'},body:'synthetic-event'}));
  return {response,writes};
}
it('actual webhook denies a cheaper subscription and releases the failed event for retry',async()=>{
  const {response,writes}=await webhookFixture(false);
  expect(response.status).toBe(400);expect(writes).toEqual([{table:'stripe_processed_events',operation:'delete'}]);
});
it('actual webhook preserves valid creator activation',async()=>{
  const {response,writes}=await webhookFixture(true);
  expect(response.status).toBe(200);expect(writes).toEqual([{table:'profiles',operation:'update'},{table:'creator_subscriptions',operation:'upsert'}]);
});
it('actual webhook does not acknowledge a failed subscription write',async()=>{
  const {response,writes}=await webhookFixture(true,true);
  expect(response.status).toBe(400);expect(writes.at(-1)).toEqual({table:'stripe_processed_events',operation:'delete'});
});
