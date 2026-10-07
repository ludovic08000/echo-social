import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsDiscussionPanel } from '../NewsDiscussionPanel';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),user:'me'}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:mocks.user?{id:mocks.user}:null})}));
vi.mock('@/components/ShareButton',()=>({ShareButton:({url}:{url:string})=><a href={url}>Partager</a>}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,from:()=>({select:()=>({in:async()=>({data:[],error:null})})})}}));
const id='00000000-0000-4000-8000-000000000001';
const comment=(n:number,user='me')=>({id:String(n),user_id:user,parent_id:null,body:`Comment ${n}`,removed:false,created_at:'2026-10-06T00:00:00Z'});
const thread={id,canonical_url:'https://paper.invalid/story',source_name:'Journal',locked:false,article:{title:'Actualité',excerpt:'Résumé'},comments:[comment(1),comment(2,'other')]};
const mount=(tid=id)=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><NewsDiscussionPanel threadId={tid}/></MemoryRouter></QueryClientProvider>);
beforeEach(()=>{mocks.user='me';mocks.rpc.mockImplementation(async(name)=>({data:name==='get_news_discussion'?thread:true,error:null}));});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('news discussion interactions',()=>{
  it('renders attribution and shares a stable ForSure discussion link',async()=>{
    mount();await screen.findByText('Actualité');
    expect(screen.getByText(/Source : Journal/)).toBeInTheDocument();
    expect(screen.getByText('Partager')).toHaveAttribute('href',`${window.location.origin}/news/${id}`);
    expect(screen.getAllByRole('button',{name:'Supprimer'})).toHaveLength(1);
  });
  it('keeps failed text and reuses the same idempotency ID on retry',async()=>{
    let writes=0;mocks.rpc.mockImplementation(async name=>name==='get_news_discussion'?{data:thread,error:null}:{data:null,error:++writes===1?new Error('offline'):null});
    mount();await screen.findByText('Actualité');
    fireEvent.change(screen.getByLabelText('Ton commentaire'),{target:{value:'Bonjour'}});
    fireEvent.click(screen.getByRole('button',{name:'Publier le commentaire'}));
    await screen.findByText(/Action non confirmée/);expect(screen.getByLabelText('Ton commentaire')).toHaveValue('Bonjour');
    fireEvent.click(screen.getByRole('button',{name:'Publier le commentaire'}));
    await waitFor(()=>expect(screen.getByLabelText('Ton commentaire')).toHaveValue(''));
    const calls=mocks.rpc.mock.calls.filter(c=>c[0]==='add_news_comment');expect(calls).toHaveLength(2);
    expect(calls[0][1].p_id).toBe(calls[1][1].p_id);expect(calls[0][1]).not.toHaveProperty('user_id');
  });
  it('sends a reply and reports into the moderation RPC',async()=>{
    mount();await screen.findByText('Actualité');fireEvent.click(screen.getAllByRole('button',{name:'Répondre'})[0]);
    fireEvent.change(screen.getByLabelText('Ton commentaire'),{target:{value:'Ma réponse'}});
    fireEvent.click(screen.getByRole('button',{name:'Publier le commentaire'}));
    await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledWith('add_news_comment',expect.objectContaining({p_parent:'1',p_body:'Ma réponse'})));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Signaler'})).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button',{name:'Signaler'}));fireEvent.click(screen.getByRole('button',{name:'Harcèlement'}));
    await screen.findByText('Signalement transmis à la modération.');
    expect(mocks.rpc).toHaveBeenCalledWith('report_news_comment',{p_id:'2',p_reason:'harassment'});
  });
  it('does not report deletion success when the server refuses it',async()=>{
    mocks.rpc.mockImplementation(async name=>({data:name==='get_news_discussion'?thread:false,error:null}));
    mount();await screen.findByText('Actualité');fireEvent.click(screen.getByRole('button',{name:'Supprimer'}));
    await screen.findByText(/Action non confirmée/);expect(screen.getByText('Comment 1')).toBeInTheDocument();
  });
  it('preserves discussions without expired publisher excerpts and renders text safely',async()=>{
    mocks.rpc.mockResolvedValue({data:{...thread,article:null,comments:[{...comment(1),body:'<img src=x onerror=alert(1)>'}]},error:null});
    const {container}=mount();await screen.findByText('Discussion d’une actualité archivée');
    expect(container.querySelector('img')).toBeNull();expect(screen.queryByText('Résumé')).toBeNull();
  });
  it('uses a bounded cursor and removes the sentinel without losing it on the next page',async()=>{
    mocks.rpc.mockImplementation(async(_name,args)=>({data:{...thread,comments:args.p_after_id?[comment(51)]:Array.from({length:51},(_,i)=>comment(i+1))},error:null}));
    mount();await screen.findByText('Comment 50');expect(screen.queryByText('Comment 51')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Afficher la suite'}));await screen.findByText('Comment 51');
    expect(mocks.rpc).toHaveBeenCalledWith('get_news_discussion',{p_thread:id,p_after_time:'2026-10-06T00:00:00Z',p_after_id:'50'});
  });
  it('does not query invalid IDs or signed-out accounts',async()=>{
    mount('invalid');expect(screen.getByText('Discussion introuvable.')).toBeInTheDocument();expect(mocks.rpc).not.toHaveBeenCalled();
    cleanup();mocks.user='';mount();expect(screen.getByText('Connexion')).toBeInTheDocument();expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
