import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { DEFAULT_DISCOVERY } from '@/lib/discovery';
import { useActiveAds } from '../useAdCampaigns';

const mocks=vi.hoisted(()=>({user:'adult-one',session:'00000000-0000-4000-8000-000000000001',preferences:{} as Record<string,unknown>,rpc:vi.fn(),invoke:vi.fn()}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:mocks.user},loading:false,session:{access_token:`h.${btoa(JSON.stringify({session_id:mocks.session}))}.s`}})}));
vi.mock('../useDiscoveryPreferences',()=>({useDiscoveryPreferences:()=>({data:mocks.preferences})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,functions:{invoke:mocks.invoke}}}));
const clients:QueryClient[]=[];
const general={id:'general',headline:'General'};const city={id:'city',headline:'Reims'};
function wrapper(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});clients.push(client);
  return ({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;}
beforeEach(()=>{
  mocks.user='adult-one';mocks.session='00000000-0000-4000-8000-000000000001';
  mocks.preferences={...DEFAULT_DISCOVERY,ads_location:true,ads_location_auto:true,updated_at:'revision-one'};
  mocks.rpc.mockReset().mockResolvedValue({data:[general],error:null});mocks.invoke.mockReset();
});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());});

describe('local ads stay off the feed critical path',()=>{
  it('renders general ads without waiting for geolocation, then fetches server-filtered local ads',async()=>{
    let finish!:(value:unknown)=>void;
    mocks.invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const hook=renderHook(()=>useActiveAds(),{wrapper:wrapper()});
    await waitFor(()=>expect(hook.result.current.data).toEqual([general]));
    expect(mocks.invoke).toHaveBeenCalledWith('ad-location',expect.objectContaining({body:{},signal:expect.any(AbortSignal)}));
    mocks.rpc.mockResolvedValue({data:[city,general],error:null});
    await act(async()=>finish({data:{location:{country:'FR',city:'Reims',region:'Grand Est',source:'profile'}},error:null}));
    await waitFor(()=>expect(hook.result.current.data).toEqual([city,general]));
    expect(mocks.rpc).toHaveBeenCalledWith('get_active_ads_for_placement',{p_placement:'feed',p_limit:12});
  });
  it('keeps serving general ads if location fails',async()=>{
    mocks.invoke.mockResolvedValue({data:null,error:new Error('unavailable')});
    const hook=renderHook(()=>useActiveAds(),{wrapper:wrapper()});
    await waitFor(()=>expect(hook.result.current.data).toEqual([general]));
    expect(hook.result.current.isError).toBe(false);
  });
  it('rechecks eligibility after a location refresh error instead of keeping an old local creative',async()=>{
    mocks.invoke.mockResolvedValueOnce({data:{location:{country:'FR',region:'Grand Est',city:'Reims',source:'network',expiresAt:new Date(Date.now()+60_000).toISOString()}},error:null});
    mocks.rpc.mockResolvedValue({data:[city,general],error:null});
    const hook=renderHook(()=>useActiveAds(),{wrapper:wrapper()});
    await waitFor(()=>expect(hook.result.current.data).toEqual([city,general]));
    mocks.rpc.mockResolvedValue({data:[general],error:null});
    mocks.invoke.mockResolvedValue({data:null,error:new Error('rate limit')});
    await act(async()=>{await clients[0].invalidateQueries({queryKey:['ad-location']});});
    await waitFor(()=>expect(hook.result.current.data).toEqual([general]));
    const query=clients[0].getQueryCache().find({queryKey:['ad-location'],exact:false})!;
    const interval=query.options as {refetchInterval?:(q:typeof query)=>number};
    expect(interval.refetchInterval?.(query)).toBe(600_000);
  });
  it.each([
    {ads_location:false,ads_location_auto:false,local_media:true},
    {ads_location:true,ads_location_auto:false},
    {ads_location:true,ads_location_auto:true,country:'FR',city:'Reims'},
  ])('does not call automatic location without both choices or when a zone is selected %j',async overrides=>{
    mocks.preferences={...DEFAULT_DISCOVERY,...overrides};
    const hook=renderHook(()=>useActiveAds(),{wrapper:wrapper()});
    await waitFor(()=>expect(hook.result.current.data).toEqual([general]));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('does not reuse another account or another session location cache',async()=>{
    let finish!:(value:unknown)=>void;
    mocks.invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
      .mockResolvedValue({data:{location:null},error:null});
    const hook=renderHook(()=>useActiveAds(),{wrapper:wrapper()});
    await waitFor(()=>expect(hook.result.current.data).toEqual([general]));
    mocks.user='adult-two';mocks.session='00000000-0000-4000-8000-000000000002';hook.rerender();
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledTimes(2));
    await act(async()=>finish({data:{location:{country:'FR',city:'Paris'}},error:null}));
    await waitFor(()=>expect(hook.result.current.data).toEqual([general]));
    mocks.session='00000000-0000-4000-8000-000000000003';hook.rerender();
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(clients[0].getQueryCache().getAll().map(q=>q.queryKey))).not.toContain('h.');
  });
});
