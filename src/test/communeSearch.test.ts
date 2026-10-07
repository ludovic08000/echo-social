import { describe, expect, it, vi } from 'vitest';
import { searchCommunes } from '../../supabase/functions/local-media-location/communes';
import { locationHandler } from '../../supabase/functions/local-media-location/location';
const rows = [{nom:'Reims',code:'51454',region:{nom:'Grand Est'},departement:{nom:'Marne'},centre:{coordinates:[4,49]}}];
describe('optional French commune lookup', () => {
  it('uses a fixed official endpoint, bounded fields and no user metadata',async()=>{
    const fetcher=vi.fn(async()=>Response.json(rows));
    expect(await searchCommunes(' Reims ',fetcher)).toEqual([{code:'51454',city:'Reims',region:'Grand Est',department:'Marne',country:'FR'}]);
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(new URL(url).origin).toBe('https://geo.api.gouv.fr');
    expect(new URL(url).searchParams.get('nom')).toBe('Reims');
    expect(init.redirect).toBe('error'); expect(init.headers).toEqual({Accept:'application/json'});
    await searchCommunes('51100',fetcher);
    expect(new URL((fetcher.mock.calls[1] as unknown as [string])[0]).searchParams.get('codePostal')).toBe('51100');
  });
  it('bounds and deduplicates results and fails on invalid/excessive responses',async()=>{
    expect(await searchCommunes('Reims',vi.fn(async()=>Response.json([...rows,...rows,{nom:'Bad',code:'xxx'},null])))).toHaveLength(1);
    await expect(searchCommunes('R',vi.fn())).rejects.toThrow('INVALID_CITY_QUERY');
    await expect(searchCommunes('Reims',vi.fn(async()=>new Response('x'.repeat(33000))))).rejects.toThrow('CITY_SEARCH_UNAVAILABLE');
    await expect(searchCommunes('Reims',vi.fn(async()=>Response.json({data:rows})))).rejects.toThrow('CITY_SEARCH_UNAVAILABLE');
    await expect(searchCommunes('Reims',vi.fn(async()=>new Response('',{status:503})))).rejects.toThrow('CITY_SEARCH_UNAVAILABLE');
  });
  it('authenticates and rate-limits town lookup separately without calling IP geolocation',async()=>{
    const deps={authenticate:vi.fn(async()=> 'user'),allow:vi.fn(async()=>true),locate:vi.fn(),search:vi.fn(async()=>[]),cors:()=>({})};
    const handle=locationHandler(deps);
    const req=(body:unknown,auth='Bearer t')=>new Request('https://test.invalid',{method:'POST',headers:{authorization:auth},body:JSON.stringify(body)});
    expect((await handle(req({cityQuery:'Reims'},''))).status).toBe(401);
    expect((await handle(req({cityQuery:'Reims',ip:'8.8.8.8'}))).status).toBe(400);
    expect((await handle(req({cityQuery:'R'}))).status).toBe(400);
    deps.allow.mockResolvedValueOnce(false);
    expect((await handle(req({cityQuery:'Reims'}))).status).toBe(429);
    expect(deps.search).not.toHaveBeenCalled();
    expect((await handle(req({cityQuery:'Reims'}))).status).toBe(200);
    expect(deps.search).toHaveBeenCalledWith('Reims');expect(deps.allow).toHaveBeenCalledWith('user','city');
    expect(deps.locate).not.toHaveBeenCalled();
  });
});
