import { describe, expect, it, vi } from 'vitest';
import { resolveMediaContext, trustedRegion } from '../../supabase/functions/local-media-location/context';
import { locationHandler } from '../../supabase/functions/local-media-location/location';
const network=()=>({country:'FR',region:'Grand Est',city:null,source:'network' as const});
const config={enabled:true,countryHeader:'gateway-country',regionHeader:'gateway-region'};
describe('coarse contextual news without extra GPS or third-party IP lookup',()=>{
  it('does not trust an arbitrary browser header or an unconfigured gateway',()=>{
    const h=new Headers({'gateway-country':'FR','gateway-region':'GES','cf-ipcountry':'US','x-forwarded-for':'8.8.8.8'});
    expect(trustedRegion(h,{enabled:true})).toBeNull();expect(trustedRegion(h,{...config,enabled:false})).toBeNull();
    expect(trustedRegion(h,config)).toEqual(network());
  });
  it.each(['GES','FR-GES','44','Grand Est','grand-est'])('normalizes the trusted %s region',code=>{
    expect(trustedRegion(new Headers({'gateway-country':'FR','gateway-region':code}),config)).toEqual(network());
  });
  it('matches a profile city without accents without choosing among homonyms',async()=>{
    const commune={country:'FR' as const,region:'Bretagne',city:'Saint-Malo',code:'35288',department:'Ille-et-Vilaine'};
    const search=vi.fn(async()=>[commune]);
    expect(await resolveMediaContext({enabled:true,profileCity:'saint malo',search,network}))
      .toMatchObject({city:'Saint-Malo',source:'profile'});
    search.mockResolvedValueOnce([commune,{...commune,code:'other'}]);
    expect(await resolveMediaContext({enabled:true,profileCity:'saint malo',search,network})).toEqual(network());
  });
  it('uses a manually selected news zone before profile or network context',async()=>{
    const search=vi.fn();const net=vi.fn(network);
    expect(await resolveMediaContext({enabled:true,profileCity:'Reims',
      selected:{enabled:true,country:'FR',region:'grand-est',city:'Charleville-Mézières'},search,network:net}))
      .toEqual({country:'FR',region:'Grand Est',city:'Charleville-Mézières',source:'selected'});
    expect(search).not.toHaveBeenCalled();expect(net).not.toHaveBeenCalled();
  });
  it('ignores a disabled or invalid saved zone and keeps the automatic fallback',async()=>{
    const search=vi.fn();const net=vi.fn(network);
    expect(await resolveMediaContext({enabled:true,profileCity:null,
      selected:{enabled:false,country:'FR',region:'Grand Est',city:'Reims'},search,network:net})).toEqual(network());
    expect(await resolveMediaContext({enabled:true,profileCity:null,
      selected:{enabled:true,country:'FR',region:'inconnue',city:'Reims'},search,network:net})).toEqual(network());
  });
  it('rejects foreign/unknown regions, not guessing a city or storing IP',()=>{
    expect(trustedRegion(new Headers({'gateway-country':'US','gateway-region':'NY'}),config)).toBeNull();
    expect(trustedRegion(new Headers({'gateway-country':'FR','gateway-region':'unknown'}),config)).toBeNull();
    expect(trustedRegion(new Headers({'gateway-country':'GP','gateway-region':'GP'}),config)?.region).toBe('Guadeloupe');
  });
  it('keeps the operator kill switch and otherwise uses the network fallback',async()=>{
    const search=vi.fn();const net=vi.fn(network);
    expect(await resolveMediaContext({enabled:false,profileCity:'Reims',search,network:net})).toBeNull();
    expect(await resolveMediaContext({enabled:true,profileCity:null,search,network:net})).toEqual(network());
    expect(search).not.toHaveBeenCalled();expect(net).toHaveBeenCalledOnce();
  });
  it('uses only an unambiguous profile city and sends no user identifier',async()=>{
    const search=vi.fn(async()=>[{country:'FR' as const,region:'Grand Est',city:'Reims',code:'51454',department:'Marne'}]);
    expect(await resolveMediaContext({enabled:true,profileCity:'Reims',search,network})).toMatchObject({city:'Reims',source:'profile'});
    expect(search).toHaveBeenCalledWith('Reims');
    search.mockResolvedValueOnce([...await search(),...await search()]);
    expect(await resolveMediaContext({enabled:true,profileCity:'Reims',search,network})).toEqual(network());
    search.mockRejectedValueOnce(new Error('offline'));
    expect(await resolveMediaContext({enabled:true,profileCity:'Reims',search,network})).toEqual(network());
  });
  it('authenticates context requests and ignores client user/IP injections',async()=>{
    const context=vi.fn(async()=>network());const locate=vi.fn();
    const handler=locationHandler({authenticate:async()=> 'authenticated-user',allow:async()=>true,context,locate,cors:()=>({})});
    const req=(body:unknown,auth='Bearer t')=>new Request('https://local.invalid',{method:'POST',headers:{authorization:auth},body:JSON.stringify(body)});
    expect((await handler(req({context:true},''))).status).toBe(401);
    expect((await handler(req({context:true,userId:'other'}))).status).toBe(400);
    expect(await(await handler(req({context:true}))).json()).toEqual({location:network()});
    expect(context).toHaveBeenCalledWith('authenticated-user',expect.objectContaining({get:expect.any(Function)}));expect(locate).not.toHaveBeenCalled();
  });
});
