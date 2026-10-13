import { renderHook,act,cleanup } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { ReactNode } from 'react';
const mocks=vi.hoisted(()=>({register:vi.fn(),purge:vi.fn(),range:vi.fn(),lookup:vi.fn(),remove:vi.fn(),callback:null as null|((payload:unknown)=>void)}));
vi.mock('@/lib/crypto/plaintextStore',()=>({registerPlaintextRetention:mocks.register}));
vi.mock('@/lib/messaging/messageLocalCleanup',()=>({purgeMessageLocalState:mocks.purge}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{
  from:(table:string)=>{const builder={select:()=>builder,eq:()=>builder,order:()=>builder,range:mocks.range,in:mocks.lookup};return builder;},
  channel:()=>{const channel={on:(_event:unknown,_filter:unknown,callback:(payload:unknown)=>void)=>{mocks.callback=callback;return channel;},subscribe:()=>channel};return channel;},
  removeChannel:mocks.remove,
}}));
import { useMessageRetention } from '../useMessageRetention';
let client:QueryClient;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));vi.clearAllMocks();
  mocks.register.mockResolvedValue(undefined);mocks.purge.mockResolvedValue(undefined);
  mocks.range.mockResolvedValue({data:[],error:null});mocks.lookup.mockResolvedValue({data:[],error:null});
  client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
});
afterEach(()=>{cleanup();client.clear();vi.useRealTimers();});
function mount(){return renderHook(()=>useMessageRetention('user'),{wrapper:({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});}
it('erases expired data from this account only and clears conversation previews',async()=>{
  const message={id:'message',body:'cipher',expires_at:new Date(Date.now()+1000).toISOString(),retention_after_read_seconds:86400};
  client.setQueryData(['messages','conversation','user'],[message]);
  client.setQueryData(['messages','conversation','other'],[message]);
  client.setQueryData(['conversations','user'],[{id:'conversation',last_message:message}]);
  mount();await act(async()=>{await vi.advanceTimersByTimeAsync(1100);});
  expect(client.getQueryData(['messages','conversation','user'])).toEqual([]);
  expect(client.getQueryData(['messages','conversation','other'])).toEqual([message]);
  expect(mocks.purge).toHaveBeenCalledWith({messageId:'message',body:'cipher',imageUrl:undefined});
  expect(client.getQueryData(['conversations','user'])).toEqual([{id:'conversation',last_message:undefined}]);
});
it('reacts immediately to an authorized server tombstone and cleans up its channel',async()=>{
  client.setQueryData(['messages','conversation','user'],[{id:'message',body:'cipher'}]);
  const {unmount}=mount();
  await act(async()=>{mocks.callback?.({new:{message_id:'message',expired_at:new Date().toISOString()}});await Promise.resolve();});
  expect(client.getQueryData(['messages','conversation','user'])).toEqual([]);
  // Une ancienne requête non annulable termine après la notification DELETE.
  client.setQueryData(['messages','conversation','user'],[{id:'message',body:'stale response',expires_at:null}]);
  client.setQueryData(['conversations','user'],[{id:'conversation',last_message:{id:'message',body:'stale preview'}}]);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1100);});
  expect(client.getQueryData(['messages','conversation','user'])).toEqual([]);
  expect(client.getQueryData(['conversations','user'])).toEqual([{id:'conversation',last_message:undefined}]);
  unmount();expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it('does not infer deletion from a network error or empty lookup',async()=>{
  const message={id:'message',body:'cipher',retention_after_read_seconds:86400,expires_at:null};
  client.setQueryData(['messages','conversation','user'],[message]);
  mocks.range.mockResolvedValue({data:null,error:{code:'NETWORK_ERROR'}});
  mount();await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(client.getQueryData(['messages','conversation','user'])).toEqual([message]);
  expect(mocks.purge).not.toHaveBeenCalled();
});
