import { act,renderHook,waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const f=vi.hoisted(()=>({send:vi.fn(),requestCall:vi.fn(),rpc:vi.fn(),getSession:vi.fn(),profile:vi.fn(),invalidate:vi.fn(),sync:vi.fn(),undo:vi.fn()}));
vi.mock('@/lib/feedPreferences',()=>({syncFeedPrefsFromServer:f.sync,undoFeedPreferenceChange:f.undo}));
vi.mock('@/hooks/useMessages',()=>({useSendMessage:()=>({mutateAsync:f.send})}));
vi.mock('@/components/ChatWidgetContext',()=>({useChatWidget:()=>({requestCall:f.requestCall})}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:f.invalidate,setQueryData:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:f.getSession},rpc:f.rpc,from:()=>{
  const q={select:()=>q,eq:()=>q,maybeSingle:f.profile};return q;
}}}));
import { useZeusCommands } from '../useZeusCommands';
import { useFeedCustomization,writeFeedCustomization } from '../useFeedCustomization';
function useConfirmedCommands(){const commands=useZeusCommands();return {execute:(...args:Parameters<typeof commands.execute>)=>commands.execute(args[0],args[1],args[2],args[3],Date.now(),true)};}
const peer='22222222-2222-4222-8222-222222222222',dm='33333333-3333-4333-8333-333333333333',post='44444444-4444-4444-8444-444444444444';
beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubGlobal('crypto',webcrypto);
  f.getSession.mockResolvedValue({data:{session:{access_token:'synthetic',user:{id:'11111111-1111-4111-8111-111111111111'}}}});
  f.profile.mockResolvedValue({data:{user_id:peer,name:'Nadège Exemple'},error:null});
  f.rpc.mockImplementation(async(name:string)=>({data:name==='zeus_capability_state'?{allowed:true,requires_confirmation:true,revision:1,checked_at:new Date().toISOString()}:name==='zeus_claim_command'?{claimed:true}:dm,error:null}));
  f.send.mockResolvedValue({id:post});f.requestCall.mockResolvedValue('L’appel a été lancé.');f.invalidate.mockResolvedValue(undefined);
});
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear();});
it('publishes only when explicitly executed and after a confirmed server receipt',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({success:true,post_id:post})));vi.stubGlobal('fetch',fetch);
  const {result}=renderHook(()=>useConfirmedCommands());expect(fetch).not.toHaveBeenCalled();
  const receipt=await result.current.execute({type:'publish_post',body:'Une bonne journée'},undefined,'one');
  expect(receipt.ok).toBe(true);expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({action:{type:'publish_post',body:'Une bonne journée'},command_key:'one',from_voice:false});
});
it('never labels an HTTP 200 without a valid receipt as published or retries it automatically',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({success:true})));vi.stubGlobal('fetch',fetch);
  const {result}=renderHook(()=>useConfirmedCommands());
  expect((await result.current.execute({type:'publish_post',body:'Texte'},undefined,'one')).ok).toBe(false);
  expect((await result.current.execute({type:'publish_post',body:'Texte'},undefined,'one')).ok).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
});
it('sends the dictated message through the existing encrypted messenger, never an AI server plaintext insert',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const {result}=renderHook(()=>useConfirmedCommands());
  const receipt=await result.current.execute({type:'send_message',recipient_name:'Nadège',message_text:'Salut, ça va ?'},{user_id:peer,name:'Nadège Exemple'},'message');
  expect(receipt.ok).toBe(true);expect(f.send).toHaveBeenCalledExactlyOnceWith({conversationId:dm,body:'Salut, ça va ?'});expect(fetch).not.toHaveBeenCalled();
});
it('does not choose or contact an ambiguous recipient',async()=>{
  const {result}=renderHook(()=>useConfirmedCommands());
  expect((await result.current.execute({type:'send_message',recipient_name:'Nadège',message_text:'Salut'},undefined,'ambiguous')).ok).toBe(false);
  expect(f.send).not.toHaveBeenCalled();expect(f.requestCall).not.toHaveBeenCalled();
});
it('rechecks voice entitlement before any outbound action',async()=>{
  f.rpc.mockResolvedValue({data:false,error:null});const {result}=renderHook(()=>useConfirmedCommands());
  expect((await result.current.execute({type:'send_message',recipient_name:'Nadège',message_text:'Salut'},{user_id:peer,name:'Nadège'},'revoked',true)).ok).toBe(false);
  expect(f.send).not.toHaveBeenCalled();expect(f.profile).not.toHaveBeenCalled();
});
it('awaits the real call widget receipt instead of claiming that a requested call already started',async()=>{
  let finish!:(value:string)=>void;f.requestCall.mockImplementation(()=>new Promise<string>(resolve=>{finish=resolve;}));
  const {result}=renderHook(()=>useConfirmedCommands());let done=false;
  const pending=result.current.execute({type:'start_call',recipient_name:'Nadège',call_type:'video'},{user_id:peer,name:'Nadège'},'call').then(receipt=>{done=true;return receipt;});
  await waitFor(()=>expect(f.requestCall).toHaveBeenCalledOnce());
  expect(done).toBe(false);
  expect(f.requestCall).toHaveBeenCalledWith(expect.objectContaining({conversationId:dm,recipientId:peer,type:'video'}));
  finish('L’appel a été lancé.');expect((await pending).ok).toBe(true);
});
it('executes a command only once even when confirmation callbacks arrive together',async()=>{
  const {result}=renderHook(()=>useConfirmedCommands());
  const action={type:'send_message' as const,recipient_name:'Nadège',message_text:'Salut'};const target={user_id:peer,name:'Nadège'};
  await Promise.all([result.current.execute(action,target,'same'),result.current.execute(action,target,'same')]);
  expect(f.send).toHaveBeenCalledOnce();
});
it('does not execute a mutation without an explicit confirmation argument',async()=>{
  const {result}=renderHook(()=>useZeusCommands());
  expect((await result.current.execute({type:'publish_post',body:'Texte'},undefined,'not-confirmed')).ok).toBe(false);
  expect(f.rpc.mock.calls.some(([name])=>name==='zeus_claim_command')).toBe(false);
});
it('does not send when another tab has already claimed the command',async()=>{
  f.rpc.mockImplementation(async(name:string)=>({data:name==='zeus_capability_state'?{allowed:true,requires_confirmation:true,revision:1,checked_at:new Date().toISOString()}:{claimed:false},error:null}));
  const {result}=renderHook(()=>useConfirmedCommands());
  expect((await result.current.execute({type:'send_message',recipient_name:'Nadège',message_text:'Salut'},{user_id:peer,name:'Nadège'},'other-tab')).ok).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
it('updates the mounted feed appearance and safely undoes only that change',async()=>{
  const feed=renderHook(()=>useFeedCustomization());const commands=renderHook(()=>useConfirmedCommands());
  let receipt!:Awaited<ReturnType<typeof commands.result.current.execute>>;
  await act(async()=>{receipt=await commands.result.current.execute({type:'update_feed_appearance',font_family:'georgia',background_color:'#0d0d1a'},undefined,'appearance');});
  expect(receipt.ok).toBe(true);expect(feed.result.current.prefs.fontFamily).toBe('georgia');
  expect(document.documentElement.style.getPropertyValue('--feed-bg-color')).toBe('#0d0d1a');
  await act(async()=>{await receipt.undo!();});expect(feed.result.current.prefs.fontFamily).toBe('system');
  act(()=>writeFeedCustomization('focus',{fontFamily:'mono',textColor:'',bgColor:''}));
  await expect(receipt.undo!()).rejects.toThrow(/a changé/);
});
it('uses the atomic personal feed RPC and exposes the existing undo operation',async()=>{
  f.rpc.mockImplementation(async(name:string)=>({data:name==='zeus_capability_state'?{allowed:true,requires_confirmation:true,revision:1,checked_at:new Date().toISOString()}:{change_id:post},error:null}));
  const {result}=renderHook(()=>useConfirmedCommands());
  const receipt=await result.current.execute({type:'update_feed_config',summary:'Plus de science',command:{more_topics:['science']}},undefined,'feed');
  expect(receipt.ok).toBe(true);expect(f.sync).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  expect(f.rpc).toHaveBeenCalledWith('zeus_execute_personal_command',expect.objectContaining({p_confirmed:true,p_action:{type:'update_feed_config',summary:'Plus de science',command:{more_topics:['science']}}}));
  await receipt.undo!();expect(f.undo).toHaveBeenCalledWith(post);
});
it('reads pending requests from the authenticated server source instead of inventing names',async()=>{
  f.rpc.mockImplementation(async(name:string)=>({data:name==='zeus_capability_state'?{allowed:true,requires_confirmation:false,revision:1,checked_at:new Date().toISOString()}:[{friendship_id:post,requester_id:peer,name:'Nadège Exemple',avatar_url:null}],error:null}));
  const {result}=renderHook(()=>useZeusCommands());
  const receipt=await result.current.execute({type:'list_friend_requests'},undefined,'requests');
  expect(receipt.message).toContain('Nadège Exemple');expect(f.send).not.toHaveBeenCalled();
});
