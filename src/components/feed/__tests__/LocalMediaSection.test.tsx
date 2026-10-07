import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { LocalMediaSection } from '../LocalMediaSection';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),invoke:vi.fn(),local:false,region:'Grand Est',saved:true}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,functions:{invoke:mocks.invoke}}}));
vi.mock('@/components/ShareButton',()=>({ShareButton:({url}:{url:string})=><a href={url}>Partager</a>}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'test'}})}));
vi.mock('@/hooks/useDiscoveryPreferences',()=>({useDiscoveryPreferences:()=>({data:{local_media:mocks.local,country:'FR',region:mocks.region,city:'Reims',updated_at:mocks.saved?'saved':undefined}})}));
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.local=false;mocks.region='Grand Est';mocks.saved=true;});
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><LocalMediaSection /></MemoryRouter></QueryClientProvider>);}
describe('partner media UI',()=>{
  it('loads contextual news in the background and provides a stable discussion/share link',async()=>{
    mocks.saved=false;mocks.region='';
    mocks.invoke.mockResolvedValue({data:{location:{country:'FR',region:'Grand Est',city:null,source:'network'}},error:null});
    mocks.rpc.mockResolvedValue({data:[{id:'x',discussion_id:'durable',title:'Local',kind:'article',canonical_url:'https://media.invalid/x',published_at:'2026-10-06',source_name:'Journal'}],error:null});
    mount();await screen.findByText(/Région approximative du réseau/);
    await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledWith('get_contextual_partner_media',{p_scope:'nearby',p_kind:'all',p_country:'FR',p_region:'Grand Est',p_city:null}));
    expect(screen.getByText('Commenter et débattre')).toHaveAttribute('href','/news/durable');
    expect(await screen.findByText('Partager')).toHaveAttribute('href',`${window.location.origin}/news/durable`);
  });
  it('does not detect location for a saved opt-out',async()=>{
    mocks.rpc.mockResolvedValue({data:[],error:null});mount();await screen.findByText(/Aucun contenu/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('shows attribution and only connects the player after a click',async()=>{
    mocks.rpc.mockResolvedValue({data:[{id:'1',title:'Vidéo partenaire',excerpt:'Extrait',canonical_url:'https://media.invalid/article',kind:'video',youtube_id:'abcdefghijk',published_at:'2026-10-05T10:00:00Z',source_name:'Partenaire'}],error:null});
    const {container}=mount();
    await screen.findByText('Vidéo partenaire');
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('button',{name:'Ma ville'})).toBeDisabled();
    expect(screen.getByText(/Choisir ma ville/).getAttribute('href')).toBe('/settings?tab=privacy');
    fireEvent.click(screen.getByRole('button',{name:'Charger la vidéo YouTube'}));
    expect(container.querySelector('iframe')?.src).toContain('https://www.youtube-nocookie.com/embed/abcdefghijk');
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'article'}});
    await waitFor(()=>expect(mocks.rpc).toHaveBeenLastCalledWith('get_local_partner_media',{p_scope:'france',p_kind:'article'}));
  });
  it('keeps errors within the optional section and never substitutes invented news',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:new Error('offline')}); mount();
    await screen.findByText(/Ton feed reste accessible/);
    expect(screen.queryByRole('article')).toBeNull();
  });
  it('routes to the chosen local scope only after local preference is enabled',async()=>{
    mocks.local=true;mocks.rpc.mockResolvedValue({data:[],error:null});mount();
    fireEvent.click(screen.getByRole('button',{name:'Ma ville'}));
    await waitFor(()=>expect(mocks.rpc).toHaveBeenLastCalledWith('get_local_partner_media',{p_scope:'city',p_kind:'all'}));
    await screen.findByText(/Aucun contenu partenaire autorisé/);
  });
  it('defaults to nearby only for a consented account, with a national fallback label',async()=>{
    mocks.local=true;mocks.rpc.mockResolvedValue({data:[{id:'n',title:'National',kind:'article',canonical_url:'https://media.invalid/n',published_at:'2026-10-06',source_name:'Journal',proximity:'national'}],error:null});mount();
    await screen.findByText('National');
    expect(mocks.rpc).toHaveBeenCalledWith('get_local_partner_media',{p_scope:'nearby',p_kind:'all'});
    expect(screen.getByRole('button',{name:'Près de moi'})).toHaveAttribute('aria-pressed','true');
    expect(screen.getByText('France · Sélection nationale')).toBeInTheDocument();
  });
});
