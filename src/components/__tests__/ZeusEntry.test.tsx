import { act,fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
const state=vi.hoisted(()=>({ creator:false }));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'test-account'}})}));
vi.mock('@/hooks/useVoiceCommandAccess',()=>({useVoiceCommandAccess:()=>({data:state.creator,isPending:false})}));
vi.mock('@/hooks/useZeusCompanion',()=>({
  useZeusSettings:()=>({zeusName:'Zeus',updateName:{mutate:vi.fn()}}),
  useZeusAgentId:()=>({data:'test-agent'}),
  useContentStrikes:()=>({unacknowledged:[],acknowledge:{mutate:vi.fn()},acknowledgeAll:{mutate:vi.fn()}}),
}));
vi.mock('@/hooks/useZeusConversations',()=>({useZeusConversations:()=>({data:[],refetch:vi.fn()}),useZeusMessages:()=>({data:[]})}));
vi.mock('@/hooks/useMessages',()=>({useSendMessage:()=>({mutateAsync:vi.fn()})}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:vi.fn()}}}));
import { ZeusCompanion } from '../ZeusCompanion';
beforeEach(()=>{
  state.creator=false;
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
});
describe('Zeus primary entry',()=>{
  it('opens Jarvis directly from the Zeus button without asking for microphone access',async()=>{
    render(<MemoryRouter><ZeusCompanion /></MemoryRouter>);
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
    render(<MemoryRouter><ZeusCompanion /></MemoryRouter>);
    act(()=>window.dispatchEvent(new CustomEvent('open-zeus')));
    expect(screen.getByRole('dialog',{name:'Bonjour, je suis Zeus'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Tester la voix de Zeus'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'Ouvrir le chat et les confirmations'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message Zeus...')).toBeInTheDocument();
  });
});
