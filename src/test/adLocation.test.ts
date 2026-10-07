import { describe, expect, it, vi } from 'vitest';
import { adLocationHandler, resolveAdLocation, trustedAdZone, type AdLocationSnapshot } from '../../supabase/functions/ad-location/context';
import { adSessionCacheKey } from '@/lib/ads/sessionCacheKey';

const snapshot: AdLocationSnapshot = { sessionId: '00000000-0000-4000-8000-000000000001', revision: '2026-10-01T00:00:00Z', cached: null, profileCity: 'Reims' };
const place={country:'FR' as const,region:'Grand Est',city:'Reims',code:'51454',department:'Marne'};
const zone={country:'FR',region:'Grand Est',city:null};
const config={enabled:true,countryHeader:'gateway-country',regionHeader:'gateway-region',cityHeader:'gateway-city'};
const request=(body:unknown={},auth='Bearer test')=>new Request('https://ad-location.invalid',{method:'POST',headers:{authorization:auth},body:JSON.stringify(body)});
const setup=()=>({enabled:true,cors:()=>({}),authenticate:vi.fn(async()=> 'verified-user'),allow:vi.fn(async()=>true),
  snapshot:vi.fn(async():Promise<AdLocationSnapshot|null>=>snapshot),search:vi.fn(async()=>[place]),network:vi.fn(async()=>zone),save:vi.fn(async()=>true)});

describe('consented automatic city advertising',()=>{
  it('accepts only configured trusted geography and never invents a city',()=>{
    const h=new Headers({'gateway-country':'FR','gateway-region':'GES','gateway-city':'Reims'});
    expect(trustedAdZone(h,{enabled:true})).toBeNull();
    expect(trustedAdZone(h,{...config,enabled:false})).toBeNull();
    expect(trustedAdZone(h,config)).toEqual({...zone,city:'Reims',source:'network'});
    h.delete('gateway-city');expect(trustedAdZone(h,config)).toEqual({...zone,source:'network'});
    h.set('gateway-city','%ZZ');expect(trustedAdZone(h,config)?.city).toBeNull();
    h.set('gateway-country','US');expect(trustedAdZone(h,config)).toBeNull();
  });
  it('uses the single canonical profile city before network, exposing only coarse fields',async()=>{
    const deps=setup();
    expect(await resolveAdLocation('Reims',deps.search,deps.network)).toEqual({...zone,city:'Reims',source:'profile'});
    expect(deps.search).toHaveBeenCalledWith('Reims');expect(deps.network).not.toHaveBeenCalled();
  });
  it('falls back on homonyms, missing profiles and lookup failure, not a guessed town',async()=>{
    const deps=setup();deps.search.mockResolvedValueOnce([place,{...place,code:'other'}]);
    expect(await resolveAdLocation('Reims',deps.search,deps.network)).toEqual({...zone,source:'network'});
    deps.search.mockRejectedValueOnce(new Error('offline'));
    expect(await resolveAdLocation('Reims',deps.search,deps.network)).toEqual({...zone,source:'network'});
    expect(await resolveAdLocation(null,deps.search,async()=>({country:'FR',region:null,city:'Reims'})))
      .toEqual({country:'FR',region:null,city:null,source:'network'});
    expect(await resolveAdLocation(null,deps.search,async()=>null)).toBeNull();
  });
  it('checks authentication, operator switch and rate limit before lookups',async()=>{
    const deps=setup();const handler=adLocationHandler(deps);
    expect((await handler(request({},''))).status).toBe(401);
    deps.authenticate.mockResolvedValueOnce('');
    expect((await handler(request())).status).toBe(401);
    deps.enabled=false;expect(await(await handler(request())).json()).toMatchObject({reason:'DISABLED'});
    deps.enabled=true;deps.allow.mockResolvedValueOnce(false);expect((await handler(request())).status).toBe(429);
    expect(deps.snapshot).not.toHaveBeenCalled();expect(deps.search).not.toHaveBeenCalled();expect(deps.network).not.toHaveBeenCalled();
  });
  it.each([{consent:true},{userId:'x'},{ip:'8.8.8.8'},{city:'Reims'},{sessionId:snapshot.sessionId}])('rejects client supplied identity, geography or consent %j',async body=>{
    const deps=setup();expect((await adLocationHandler(deps)(request(body))).status).toBe(400);expect(deps.snapshot).not.toHaveBeenCalled();
  });
  it('does not locate if the server reports no consent, a minor, or an existing manual selection',async()=>{
    const deps=setup();deps.snapshot.mockResolvedValue(null);
    expect(await(await adLocationHandler(deps)(request())).json()).toEqual({location:null,reason:'NOT_ELIGIBLE'});
    expect(deps.search).not.toHaveBeenCalled();expect(deps.network).not.toHaveBeenCalled();expect(deps.save).not.toHaveBeenCalled();
  });
  it('reuses the bounded session cache including negative results',async()=>{
    const deps=setup();const cached={...zone,source:'network' as const,expiresAt:'2026-10-01T00:15:00Z'};
    deps.snapshot.mockResolvedValueOnce({...snapshot,cached});
    expect(await(await adLocationHandler(deps)(request())).json()).toEqual({location:cached});
    deps.snapshot.mockResolvedValueOnce({...snapshot,cached:{country:null,region:null,city:null,source:'unavailable',expiresAt:cached.expiresAt}});
    expect(await(await adLocationHandler(deps)(request())).json()).toEqual({location:null});
    expect(deps.network).not.toHaveBeenCalled();expect(deps.save).not.toHaveBeenCalled();
  });
  it('commits only for verified user and snapshot session; drops an in-flight result after withdrawal',async()=>{
    const deps=setup();const handler=adLocationHandler(deps);
    const result=await handler(request());expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({location:{...zone,city:'Reims',source:'profile'}});
    expect(deps.save).toHaveBeenCalledWith('verified-user',snapshot,{...zone,city:'Reims',source:'profile'});
    deps.save.mockResolvedValueOnce(false);
    expect(await(await handler(request())).json()).toEqual({location:null,reason:'PREFERENCES_CHANGED'});
  });
  it('fails closed on backend errors without exposing errors or requesting IP',async()=>{
    const deps=setup();deps.snapshot.mockRejectedValueOnce(new Error('secret database payload'));
    const result=await adLocationHandler(deps)(request());expect(result.status).toBe(503);
    expect(await result.json()).toEqual({error:'AD_LOCATION_UNAVAILABLE'});expect(deps.network).not.toHaveBeenCalled();
  });
  it('partitions frontend cache by session identifier without retaining a token',()=>{
    const token=`header.${btoa(JSON.stringify({session_id:snapshot.sessionId,secret:'not retained'}))}.signature`;
    expect(adSessionCacheKey(token)).toBe(snapshot.sessionId);
    expect(adSessionCacheKey('invalid')).toBeNull();expect(adSessionCacheKey(undefined)).toBeNull();
    expect(adSessionCacheKey(`h.${btoa('{"session_id":"not-a-session"}')}.s`)).toBeNull();
  });
});
