import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const { toast, getSession } = vi.hoisted(() => ({ toast: vi.fn(), getSession: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [], refetch: vi.fn() }), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession, getUser: async () => ({ data: { user: null } }) } } }));
vi.mock('@/components/SafeMarkdown', () => ({ SafeMarkdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { ZeusSection } from '@/components/admin/ZeusSection';
const proposal = '[ZEUS_PROPOSAL]\naction: update_algorithm_config\nkey: scoring_weights\nupdates: {"friend_boost":9}\nreason: Proposition synthétique\n[/ZEUS_PROPOSAL]';
const streamResponse = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: proposal } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
beforeEach(() => { vi.clearAllMocks(); getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic-jwt' } } }); Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function openProposal(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetch); render(<ZeusSection />);
  const input = screen.getByPlaceholderText('Commandez Zeus...'); fireEvent.change(input, { target: { value: 'Prépare une proposition' } }); fireEvent.keyDown(input, { key: 'Enter' });
  return await screen.findByRole('button', { name: /Valider/ });
}
it.each([{}, { success: true }, { success: true, applied: false }])('never labels an unconfirmed HTTP 200 as applied: %j', async result => {
  const fetch = vi.fn().mockResolvedValueOnce(streamResponse()).mockResolvedValueOnce(new Response(JSON.stringify(result)));
  fireEvent.click(await openProposal(fetch));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: 'Application non confirmée par le serveur.' })));
  expect(screen.queryByText('✅ Appliquée')).not.toBeInTheDocument();
});
it('displays the applied badge only after an explicit server confirmation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(streamResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, applied: true })));
  fireEvent.click(await openProposal(fetch)); expect(await screen.findByText('✅ Appliquée')).toBeInTheDocument();
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ domain: 'admin', action: 'apply_proposal', key: 'scoring_weights', updates: { friend_boost: 9 } });
});
it('allows one in-flight request per human proposal and disables conflicting controls', async () => {
  let complete!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(streamResponse()).mockReturnValueOnce(pending);
  const button = await openProposal(fetch); fireEvent.click(button);
  await screen.findByRole('button', { name: 'Application…' }); fireEvent.click(button);
  expect(fetch).toHaveBeenCalledTimes(2); expect(screen.getByRole('button', { name: /Refuser/ })).toBeDisabled();
  await act(async () => { complete(new Response(JSON.stringify({ success: true, applied: true }))); });
  expect(await screen.findByText('✅ Appliquée')).toBeInTheDocument();
});
