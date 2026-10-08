import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { LocalMediaSection } from '../LocalMediaSection';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),invoke:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,functions:{invoke:mocks.invoke}}}));
vi.mock('@/components/ShareButton',()=>({ShareButton:({url}:{url:string})=><a href={url}>Partager</a>}));
vi.mock('../NewsDiscussionPanel',()=>({NewsDiscussionPanel:()=> <div>Formulaire de commentaires réel</div>}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'test'}})}));
beforeEach(()=>mocks.invoke.mockResolvedValue({data:{location:null},error:null}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><LocalMediaSection /></MemoryRouter></QueryClientProvider>);}
describe('partner media UI',()=>{
  it('loads contextual news in the background and provides a stable discussion/share link',async()=>{
    mocks.invoke.mockResolvedValue({data:{location:{country:'FR',region:'Grand Est',city:null,source:'network'}},error:null});
    mocks.rpc.mockResolvedValue({data:[{id:'x',discussion_id:'durable',title:'Local',kind:'article',canonical_url:'https://media.invalid/x',published_at:'2026-10-06',source_name:'Journal'}],error:null});
    mount();await screen.findByRole('link',{name:/Zone IP approximative.*Grand Est.*Modifier/});
    await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledWith('get_contextual_partner_media',{p_scope:'nearby',p_kind:'all',p_country:'FR',p_region:'Grand Est',p_city:null}));
    expect(screen.getByRole('button',{name:/Commenter et débattre/})).toHaveAttribute('aria-expanded','false');
    fireEvent.click(screen.getByRole('button',{name:/Commenter et débattre/}));
    expect(await screen.findByText('Formulaire de commentaires réel')).toBeInTheDocument();
    expect(screen.getByText('Ouvrir la discussion')).toHaveAttribute('href','/news/durable');
    expect(await screen.findByText('Partager')).toHaveAttribute('href',`${window.location.origin}/news/durable`);
    expect(screen.getByText('Aperçu de l’actualité')).toBeInTheDocument();
  });
  it('always requests automatic context and falls back to France',async()=>{
    mocks.rpc.mockResolvedValue({data:[],error:null});mount();await screen.findByText(/Aucun contenu/);
    expect(mocks.invoke).toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('get_contextual_partner_media',{p_scope:'france',p_kind:'all',p_country:'FR',p_region:'',p_city:null});
  });
  it('shows attribution and only connects the player after a click',async()=>{
    mocks.rpc.mockResolvedValue({data:[{id:'00000000-0000-4000-8000-000000000001',title:'Vidéo partenaire',excerpt:'Extrait',canonical_url:'https://media.invalid/article',thumbnail_url:'https://img.invalid/thumb.jpg',kind:'video',youtube_id:'abcdefghijk',published_at:'2026-10-05T10:00:00Z',source_name:'Partenaire'}],error:null});
    const {container}=mount();
    await screen.findByText('Vidéo partenaire');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/functions/v1/partner-media-thumbnail?id=');
    expect(container.querySelector('img')?.getAttribute('src')).not.toContain('img.invalid');
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByText('Aperçu vidéo')).toBeInTheDocument();
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByRole('group',{name:'Zone des médias'})).toBeNull();
    expect(screen.getByRole('link',{name:/Choisir ma ville/})).toHaveAttribute('href','/settings?tab=privacy#discovery-heading');
    fireEvent.click(screen.getByRole('button',{name:'Charger la vidéo YouTube'}));
    expect(container.querySelector('iframe')?.src).toContain('https://www.youtube-nocookie.com/embed/abcdefghijk');
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'article'}});
    await waitFor(()=>expect(mocks.rpc).toHaveBeenLastCalledWith('get_contextual_partner_media',{p_scope:'france',p_kind:'article',p_country:'FR',p_region:'',p_city:null}));
  });
  it('keeps errors within the optional section and never substitutes invented news',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:new Error('offline')}); mount();
    await screen.findByText(/Ton feed reste accessible/);
    expect(screen.queryByRole('article')).toBeNull();
  });
  it('routes to the detected city without a media preference',async()=>{
    mocks.invoke.mockResolvedValue({data:{location:{country:'FR',region:'Grand Est',city:'Reims',source:'profile'}},error:null});
    mocks.rpc.mockResolvedValue({data:[],error:null});mount();
    await screen.findByText(/Ville du profil/);
    expect(screen.getByRole('link',{name:/Ville du profil.*Modifier/})).toHaveAttribute('href','/settings?tab=privacy#discovery-heading');
    await waitFor(()=>expect(mocks.rpc).toHaveBeenLastCalledWith('get_contextual_partner_media',{p_scope:'nearby',p_kind:'all',p_country:'FR',p_region:'Grand Est',p_city:'Reims'}));
    await screen.findByText(/Aucun contenu partenaire autorisé/);
  });
  it('defaults to nearby for automatic context, with a national fallback label',async()=>{
    mocks.invoke.mockResolvedValue({data:{location:{country:'FR',region:'Grand Est',city:null,source:'network'}},error:null});
    mocks.rpc.mockResolvedValue({data:[{id:'n',title:'National',kind:'article',canonical_url:'https://media.invalid/n',published_at:'2026-10-06',source_name:'Journal',proximity:'national'}],error:null});mount();
    await screen.findByText('National');
    expect(mocks.rpc).toHaveBeenCalledWith('get_contextual_partner_media',{p_scope:'nearby',p_kind:'all',p_country:'FR',p_region:'Grand Est',p_city:null});
    expect(screen.queryByRole('group',{name:'Zone des médias'})).toBeNull();
    expect(screen.getByText('France · Sélection nationale')).toBeInTheDocument();
  });
});
