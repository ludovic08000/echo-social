// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const code=ts.transpileModule(readFileSync('supabase/functions/_shared/payment-authority.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const api=new Function('Deno','exports',code+';return exports;')({env:{get:()=>undefined}},{});
const order={id:'order-1',buyer_id:'buyer-1',total:100,stripe_checkout_session_id:'cs_exact',stripe_customer_id:'cus_exact',payment_intent_id:'pi_exact'};
const session={id:'cs_exact',mode:'payment',payment_status:'paid',currency:'eur',amount_total:10000,customer:'cus_exact',client_reference_id:'buyer-1',payment_intent:'pi_exact',metadata:{order_id:'order-1',user_id:'buyer-1'}};
const intent={id:'pi_exact',status:'succeeded',currency:'eur',amount:10000,amount_received:10000,customer:'cus_exact',metadata:{order_id:'order-1',user_id:'buyer-1'}};

describe('server-owned payment authority',()=>{
  it('accepts the exact paid order binding',()=>expect(()=>api.assertMarketplacePayment(session,intent,order)).not.toThrow());
  it.each([
    {amount_total:1},{currency:'usd'},{payment_status:'unpaid'},{id:'cs_other'},
    {metadata:{order_id:'other',user_id:'buyer-1'}},{metadata:{order_id:'order-1',user_id:'other'}},
    {customer:'cus_other'},{client_reference_id:'other'},{mode:'subscription'},
  ])('rejects a changed Checkout binding: %j',patch=>{
    expect(()=>api.assertMarketplacePayment({...session,...patch},intent,order)).toThrow('PAYMENT_BINDING_MISMATCH');
  });
  it.each([{id:'pi_other'},{amount:1},{amount_received:1},{currency:'usd'},{status:'processing'},{customer:'cus_other'},
    {metadata:{order_id:'other'}},{metadata:{user_id:'other'}}])('rejects a changed PaymentIntent: %j',patch=>{
    expect(()=>api.assertMarketplacePayment(session,{...intent,...patch},order)).toThrow('PAYMENT_BINDING_MISMATCH');
  });
  it('does not trust paid status without Stripe proof',async()=>{
    const rpc=vi.fn();
    expect(await api.settleMarketplacePayment({rpc},{}, {id:'unproven',status:'paid'})).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('uses one database transaction after verification, not separate stock writes',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:true,error:null});
    const stripe={checkout:{sessions:{retrieve:vi.fn().mockResolvedValue(session)}},paymentIntents:{retrieve:vi.fn().mockResolvedValue(intent)}};
    expect(await api.settleMarketplacePayment({rpc},stripe,order)).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('settle_marketplace_payment',{
      p_order_id:order.id,p_buyer_id:order.buyer_id,p_session_id:session.id,p_payment_intent_id:intent.id,p_amount_cents:10000,p_currency:'eur',
    });
  });
  it('propagates settlement failure rather than showing paid',async()=>{
    const rpc=vi.fn().mockResolvedValue({error:new Error('stock failure')});
    await expect(api.settleMarketplacePayment({rpc},{paymentIntents:{retrieve:async()=>intent}},order,session)).rejects.toThrow('stock failure');
  });
  it('accepts only the server creator catalog, not another active fan-club price',()=>{
    const price={id:api.DEFAULT_CREATOR_PRICE_ID,active:true,currency:'eur',unit_amount:499,recurring:{interval:'month',interval_count:1}};
    expect(api.isCreatorPrice(price)).toBe(true);
    for(const patch of [{id:'price_fan'},{unit_amount:199},{currency:'usd'},{recurring:{interval:'year'}},{active:false}]){
      expect(api.isCreatorPrice({...price,...patch})).toBe(false);
    }
  });
  it('never uses an untrusted request origin for a payment redirect',()=>{
    expect(api.paymentReturnOrigin(new Request('https://local.invalid',{headers:{Origin:'https://evil.invalid'}}))).toBe('https://forsure.fans');
    expect(api.paymentReturnOrigin(new Request('https://local.invalid',{headers:{Origin:'https://www.forsure.fans'}}))).toBe('https://www.forsure.fans');
  });
});
