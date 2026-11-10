import { act,cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { MemoryRouter,useLocation } from 'react-router-dom';
import { webcrypto } from 'node:crypto';
import { setImmediate as realImmediate } from 'node:timers/promises';
const f=vi.hoisted(()=>({send:vi.fn(),rpc:vi.fn(),fetch:vi.fn(),spoken:[] as string[],history:[] as {id:string;role:string;content:string}[],requests:[] as {friendship_id:string;requester_id:string;name:string;avatar_url:null}[]}));
const owner='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222',dm='33333333-3333-4333-8333-333333333333';
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'11111111-1111-4111-8111-111111111111'}})}));
vi.mock('@/hooks/useVoiceCommandAccess',()=>({useVoiceCommandAccess:()=>({data:true,isPending:false})}));
vi.mock('@/hooks/useZeusCompanion',()=>({useZeusSettings:()=>({zeusName:'Zeus',updateName:{mutate:vi.fn()}}),useZeusAgentId:()=>({data:'55555555-5555-4555-8555-555555555555'}),useContentStrikes:()=>({unacknowledged:[],acknowledge:{mutate:vi.fn()},acknowledgeAll:{mutate:vi.fn()}})}));
vi.mock('@/hooks/useZeusConversations',()=>({useZeusConversations:()=>({data:[],refetch:vi.fn()}),useZeusMessages:()=>({data:f.history})}));
vi.mock('@/hooks/useMessages',()=>({useSendMessage:()=>({mutateAsync:f.send})}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn(),setQueryData:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:async()=>({data:{session:{access_token:'synthetic',user:{id:'11111111-1111-4111-8111-111111111111'}}}}),getUser:async()=>({data:{user:{id:'11111111-1111-4111-8111-111111111111'}}})},rpc:f.rpc,from:()=>{
  const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{user_id:'22222222-2222-4222-8222-222222222222',name:'Nadège Exemple'},error:null})};return q;
}}}));
import { ZeusCompanion } from '../ZeusCompanion';
import { ChatWidgetProvider } from '../ChatWidgetContext';
class Recognition {
  static current:Recognition;continuous=false;interimResults=false;lang='';maxAlternatives=1;
  onresult:((event:{results:ArrayLike<ArrayLike<{transcript:string}>&{isFinal:boolean}>})=>void)|null=null;
  onend:(()=>void)|null=null;onerror:((event:{error:string})=>void)|null=null;
  start=vi.fn();stop=vi.fn();abort=vi.fn();constructor(){Recognition.current=this;}
}
function CurrentRoute(){return <output data-testid="route">{useLocation().pathname}</output>;}
function TestApp(){return <MemoryRouter><CurrentRoute/><ChatWidgetProvider><ZeusCompanion /></ChatWidgetProvider></MemoryRouter>;}
function open(){const view=render(<TestApp/>);fireEvent.click(screen.getByRole('button',{name:'Ouvrir Zeus'}));fireEvent.click(screen.getByRole('button',{name:'Parler à Zeus'}));return view;}
async function say(text:string){await act(async()=>{Recognition.current.onresult?.({results:[Object.assign([{transcript:text}],{isFinal:true})]});await vi.advanceTimersByTimeAsync(1500);await realImmediate();await vi.advanceTimersByTimeAsync(1);});}
function model(action:object){const content='Proposition\n```forsure-action\n'+JSON.stringify(action)+'\n```';return new Response('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}
beforeEach(()=>{
  vi.useFakeTimers();vi.resetAllMocks();f.spoken=[];
  f.requests=[];f.history=[];vi.stubGlobal('crypto',webcrypto);
  f.send.mockResolvedValue({id:'44444444-4444-4444-8444-444444444444'});
  f.rpc.mockImplementation(async(name:string,args?:{p_capability?:string})=>({error:null,data:name==='zeus_capability_state'?{allowed:true,requires_confirmation:!['activity.read','friend_requests.list','friend_requests.show_profile'].includes(args?.p_capability||''),revision:1,checked_at:new Date().toISOString()}:name==='zeus_claim_command'?{claimed:true}:name==='zeus_pending_friend_requests'?f.requests:name==='zeus_execute_personal_command'?{friendship_id:'88888888-8888-4888-8888-888888888888',requester_id:peer,decision:'accepted'}:name==='voice_command_access'?true:name==='zeus_find_contacts'?[{user_id:peer,name:'Nadège Exemple'},{user_id:'66666666-6666-4666-8666-666666666666',name:'Nadège Autre'}]:dm}));
  vi.stubGlobal('fetch',f.fetch);vi.stubGlobal('webkitSpeechRecognition',Recognition);
  vi.stubGlobal('SpeechSynthesisUtterance',class {volume=1;onend?:()=>void;constructor(public text:string){} });
  vi.stubGlobal('speechSynthesis',{cancel:vi.fn(),getVoices:()=>[],speak:(utterance:{text:string;onend?:()=>void})=>{f.spoken.push(utterance.text);void Promise.resolve().then(()=>utterance.onend?.());}});
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();localStorage.clear();});
it('carries a real UI voice request through disambiguation and confirmation into the encrypted send hook',async()=>{
  f.fetch.mockImplementation(async()=>model({type:'send_message',recipient_name:'Nadège',message_text:'Salut, ça va ?'}));
  open();await say('Envoie à Nadège : salut, ça va ?');
  expect(f.send).not.toHaveBeenCalled();expect(f.spoken.some(text=>text.includes('Plusieurs personnes'))).toBe(true);
  await say('Nadège Exemple');expect(f.send).not.toHaveBeenCalled();
  await say('oui je confirme');
  expect(f.send).toHaveBeenCalledExactlyOnceWith({conversationId:dm,body:'Salut, ça va ?'});
  expect(f.fetch).toHaveBeenCalledOnce();expect(f.spoken.some(text=>text.includes('Message envoyé à Nadège Exemple'))).toBe(true);
  expect(f.rpc).toHaveBeenCalledWith('create_or_get_dm_conversation',{p_other_user:peer});
});
it('cancels a prepared publication without any outbound publication call',async()=>{
  f.fetch.mockImplementation(async()=>model({type:'publish_post',body:'Une belle journée'}));
  open();await say('Publie une belle journée');await say('annule');
  expect(f.fetch).toHaveBeenCalledOnce();expect(screen.queryByRole('button',{name:'Confirmer la proposition'})).not.toBeInTheDocument();
});
it('cannot execute a cancelled proposal from an old chat confirmation card',async()=>{
  f.fetch.mockImplementation(async()=>model({type:'publish_post',body:'Une belle journée'}));
  open();await say('Publie une belle journée');await say('annule');
  fireEvent.click(screen.getByRole('button',{name:'Ouvrir le chat et les confirmations'}));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Confirmer'}));});
  expect(f.fetch).toHaveBeenCalledOnce();
});
it('expires a prepared proposal in the written chat as well as the voice view',async()=>{
  f.fetch.mockImplementation(async()=>model({type:'publish_post',body:'Une belle journée'}));
  open();await say('Publie une belle journée');
  fireEvent.click(screen.getByRole('button',{name:'Ouvrir le chat et les confirmations'}));
  vi.setSystemTime(Date.now()+5*60_000+1);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Confirmer'}));});
  expect(f.fetch).toHaveBeenCalledOnce();
});
it('requires confirmation and a server post identifier before announcing a publication',async()=>{
  f.fetch.mockImplementation(async(url:string)=>url.includes('agent-actions')?new Response(JSON.stringify({success:true,post_id:'77777777-7777-4777-8777-777777777777'})):model({type:'publish_post',body:'Une belle journée'}));
  open();await say('Publie une belle journée');expect(f.fetch).toHaveBeenCalledOnce();await say('je confirme');
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(f.fetch.mock.calls[1][1].body)).toEqual({action:{type:'publish_post',body:'Une belle journée'},command_key:expect.any(String),from_voice:true});
  expect(f.spoken.some(text=>text.includes('Ta publication est publiée sur le feed.'))).toBe(true);
});
it('opens the selected request profile after resolving homonyms without accepting the request',async()=>{
  f.requests=[{friendship_id:'88888888-8888-4888-8888-888888888888',requester_id:peer,name:'Nadège Exemple',avatar_url:null},{friendship_id:'99999999-9999-4999-8999-999999999999',requester_id:'66666666-6666-4666-8666-666666666666',name:'Nadège Autre',avatar_url:null}];
  f.fetch.mockImplementation(async()=>model({type:'show_friend_request_profile',requester_name:'Nadège'}));
  open();await say('Montre le profil de Nadège qui veut être mon amie');await say('Nadège Exemple');
  expect(screen.getByTestId('route')).toHaveTextContent('/profile/'+peer);
  expect(f.rpc.mock.calls.some(([name])=>name==='zeus_execute_personal_command')).toBe(false);
});
it('confirms a real pending friend request by server id and announces only its confirmed decision',async()=>{
  f.requests=[{friendship_id:'88888888-8888-4888-8888-888888888888',requester_id:peer,name:'Nadège Exemple',avatar_url:null}];
  f.fetch.mockImplementation(async()=>model({type:'respond_friend_request',requester_name:'Nadège Exemple',decision:'accept'}));
  open();await say('Accepte Nadège Exemple');
  expect(f.rpc.mock.calls.some(([name])=>name==='zeus_execute_personal_command')).toBe(false);
  await say('je confirme');
  expect(f.rpc).toHaveBeenCalledWith('zeus_execute_personal_command',expect.objectContaining({p_action:{type:'respond_friend_request',friendship_id:'88888888-8888-4888-8888-888888888888',decision:'accept'},p_confirmed:true}));
  expect(f.spoken.some(text=>text.includes('a été acceptée'))).toBe(true);
});
it('preserves the new proposal when initial server history arrives after the conversation header',async()=>{
  f.fetch.mockImplementation(async(url:string)=>{
    if(url.includes('agent-actions'))return new Response(JSON.stringify({success:true,post_id:'77777777-7777-4777-8777-777777777777'}));
    const response=model({type:'publish_post',body:'Une proposition récente'});response.headers.set('X-Conversation-Id',dm);return response;
  });
  const view=open();await say('Publie une proposition récente');
  f.history=[{id:'99999999-9999-4999-8999-999999999999',role:'assistant',content:'Un historique ancien'}];view.rerender(<TestApp/>);
  await say('je confirme');
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.spoken.some(text=>text.includes('Ta publication est publiée sur le feed.'))).toBe(true);
});
it('ignores an older reply after the user starts a different conversation',async()=>{
  let finish!:(response:Response)=>void;f.fetch.mockImplementation(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  open();await say('Prépare un ancien brouillon');
  fireEvent.click(screen.getByRole('button',{name:'Ouvrir le chat et les confirmations'}));
  fireEvent.click(screen.getByRole('button',{name:'Nouvelle conversation'}));
  await act(async()=>{finish(model({type:'publish_post',body:'Un ancien brouillon'}));await realImmediate();});
  expect(screen.queryByText(/Publier sur ton feed.*Un ancien brouillon/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Confirmer'})).not.toBeInTheDocument();
});
