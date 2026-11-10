import { act,fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatWidgetProvider } from '@/components/ChatWidgetContext';
const state=vi.hoisted(()=>({ creator:false,rpc:vi.fn(),setQueryData:vi.fn() }));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'test-account'}})}));
vi.mock('@/hooks/useVoiceCommandAccess',()=>({useVoiceCommandAccess:()=>({data:state.creator,isPending:false})}));
vi.mock('@/hooks/useZeusCompanion',()=>({
  useZeusSettings:()=>({zeusName:'Zeus',updateName:{mutate:vi.fn()}}),
  useZeusAgentId:()=>({data:'test-agent'}),
  useContentStrikes:()=>({unacknowledged:[],acknowledge:{mutate:vi.fn()},acknowledgeAll:{mutate:vi.fn()}}),
}));
vi.mock('@/hooks/useZeusConversations',()=>({useZeusConversations:()=>({data:[],refetch:vi.fn()}),useZeusMessages:()=>({data:[]})}));
vi.mock('@/hooks/useMessages',()=>({useSendMessage:()=>({mutateAsync:vi.fn()})}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn(),setQueryData:state.setQueryData})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:'test-account'}}}})},rpc:state.rpc}}));
import { ZeusCompanion } from '../ZeusCompanion';
beforeEach(()=>{
  state.creator=false;
  state.rpc.mockReset();state.setQueryData.mockReset();
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
});
afterEach(()=>{
  vi.unstubAllGlobals();
  localStorage.removeItem('forsure-voice-settings');
});
describe('Zeus primary entry',()=>{
  it('reads the exact fresh server counts aloud, including replies to publications',async()=>{
    state.creator=true;
    state.rpc.mockResolvedValue({data:{unread_messages:62,unread_notifications:73,publication_replies:9,friend_requests:2,checked_at:new Date().toISOString()},error:null});
    const spoken:string[]=[];
    vi.stubGlobal('SpeechSynthesisUtterance',class {volume=1;onend?:()=>void;constructor(public text:string){} });
    vi.stubGlobal('speechSynthesis',{cancel:vi.fn(),getVoices:()=>[],speak:(utterance:{text:string;onend?:()=>void})=>{spoken.push(utterance.text);queueMicrotask(()=>utterance.onend?.());}});
    render(<MemoryRouter><ChatWidgetProvider><ZeusCompanion /></ChatWidgetProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'Ouvrir Zeus'}));
    fireEvent.click(screen.getByRole('button',{name:'Lire mon bilan : messages et notifications'}));
    await within(screen.getByRole('dialog')).findByText(/Tu as 62 messages non lus et 73 notifications non lues, dont 9 réponses/);
    await waitFor(()=>expect(spoken.some(text=>text.includes('62 messages non lus')&&text.includes('9 réponses'))).toBe(true));
    expect(state.rpc).toHaveBeenCalledWith('zeus_activity_summary');
  });
  it('reports an unavailable summary instead of announcing fake zero counts',async()=>{
    state.rpc.mockResolvedValue({data:null,error:{message:'unavailable'}});
    render(<MemoryRouter><ChatWidgetProvider><ZeusCompanion /></ChatWidgetProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'Ouvrir Zeus'}));
    fireEvent.click(screen.getByRole('button',{name:'Lire mon bilan : messages et notifications'}));
    await screen.findByText('Le bilan de votre compte est momentanément indisponible.');
    expect(screen.queryByText(/0 message non lu/)).not.toBeInTheDocument();
  });
  it('cancels the spoken reply before opening the microphone and uses the chosen voice language',()=>{
    state.creator=true;
    const cancel=vi.fn(),speak=vi.fn(),start=vi.fn(()=>expect(cancel).toHaveBeenCalledTimes(2));
    let chosenLanguage='';
    vi.stubGlobal('SpeechSynthesisUtterance',class { volume=1;constructor(public text:string){} });
    vi.stubGlobal('speechSynthesis',{cancel,speak,getVoices:()=>[]});
    vi.stubGlobal('webkitSpeechRecognition',class {
      continuous=false;interimResults=false;maxAlternatives=1;
      set lang(value:string){chosenLanguage=value;}
      onend=null;onresult=null;onerror=null;
      start=start;stop=vi.fn();abort=vi.fn();
    });
    localStorage.setItem('forsure-voice-settings',JSON.stringify({voice_lang:'de-DE',voice_consent_version:1}));
    render(<MemoryRouter><ChatWidgetProvider><ZeusCompanion /></ChatWidgetProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'Ouvrir Zeus'}));
    fireEvent.click(screen.getByRole('button',{name:'Parler à Zeus'}));
    expect(start).toHaveBeenCalledOnce();
    expect(chosenLanguage).toBe('de-DE');
    expect(speak).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({text:'',volume:0}));
    fireEvent.click(screen.getByRole('button',{name:'Fermer l’interface vocale'}));
  });
  it('opens Jarvis directly from the Zeus button without asking for microphone access',async()=>{
    render(<MemoryRouter><ChatWidgetProvider><ZeusCompanion /></ChatWidgetProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'Ouvrir Zeus'}));
    const panel=screen.getByRole('dialog',{name:'Bonjour, je suis Zeus'});
    expect(panel.parentElement).toBe(document.body);
    expect(within(panel).getByRole('textbox')).toBeEnabled();
    expect(within(panel).getByRole('button',{name:'Découvrir les commandes vocales Créateur'})).toBeEnabled();
    fireEvent.click(within(panel).getByRole('button',{name:'Fermer l’interface vocale'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(()=>expect(screen.queryByPlaceholderText('Message Zeus...')).not.toBeInTheDocument());
  });
  it('uses the same Jarvis entry from the feed event and exposes creator speech',()=>{
    state.creator=true;
    render(<MemoryRouter><ChatWidgetProvider><ZeusCompanion /></ChatWidgetProvider></MemoryRouter>);
    act(()=>window.dispatchEvent(new CustomEvent('open-zeus')));
    expect(screen.getByRole('dialog',{name:'Bonjour, je suis Zeus'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Tester la voix de Zeus'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'Ouvrir le chat et les confirmations'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message Zeus...')).toBeInTheDocument();
  });
});
