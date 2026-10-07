import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareButton } from '@/components/ShareButton';
import { newsReportTarget } from '@/lib/newsDiscussion';
const mocks=vi.hoisted(()=>({insert:vi.fn(),toast:vi.fn(),conversations:vi.fn(()=>({data:[]}))}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'me'}})}));
vi.mock('@/hooks/use-toast',()=>({toast:mocks.toast}));
vi.mock('@/hooks/useMessages',()=>({useConversations:mocks.conversations,useCreateConversation:vi.fn(),useSendMessage:()=>({mutateAsync:vi.fn()})}));
vi.mock('@/components/ChatWidgetContext',()=>({useChatWidget:()=>({openConversation:vi.fn()})}));
vi.mock('@/components/UserAvatar',()=>({UserAvatar:()=>null}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>({insert:mocks.insert})}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const mount=()=>render(<QueryClientProvider client={new QueryClient()}><ShareButton url="https://forsure.fans/news/123" title="Discussion" showLabel /></QueryClientProvider>);
describe('news uses the real shared social publishing flow',()=>{
  it('does not preload private conversations for every news card',()=>{mount();expect(mocks.conversations).not.toHaveBeenCalled();});
  it('reports actual feed write failures instead of pretending a share succeeded',async()=>{
    mocks.insert.mockResolvedValue({error:{message:'denied'}});mount();fireEvent.click(screen.getByRole('button',{name:'Partager'}));
    fireEvent.click(screen.getByRole('button',{name:'Mon fil'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith({title:'Erreur',variant:'destructive'}));
    expect(mocks.toast.mock.calls.some(c=>c[0].title==='Partagé !')).toBe(false);
  });
  it('publishes a discussion link under the authenticated member, not the newspaper',async()=>{
    mocks.insert.mockResolvedValue({error:null});mount();fireEvent.click(screen.getByRole('button',{name:'Partager'}));
    fireEvent.click(screen.getByRole('button',{name:'Mon fil'}));
    await waitFor(()=>expect(mocks.insert).toHaveBeenCalledWith({user_id:'me',body:'🔗 Discussion\n\nhttps://forsure.fans/news/123'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'Partagé !'})));
  });
  it('only offers admin moderation on a strict first-party comment reference',()=>{
    const id='00000000-0000-4000-8000-000000000001';
    expect(newsReportTarget(`https://forsure.fans/news/${id}#comment-${id}`)).toEqual({thread:id,comment:id});
    expect(newsReportTarget(`https://forsure.fans.evil/news/${id}#comment-${id}`)).toBeNull();
    expect(newsReportTarget('javascript:alert(1)')).toBeNull();
  });
});
