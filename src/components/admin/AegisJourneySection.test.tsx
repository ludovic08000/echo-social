import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AegisJourneySection } from './AegisJourneySection';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), admin: true }));
vi.mock('@/integrations/supabase/client', () => ({supabase:{rpc:mocks.rpc}}));
vi.mock('@/hooks/useIsAdmin', () => ({useIsAdmin:() => ({data:mocks.admin})}));
function mount() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><AegisJourneySection /></QueryClientProvider>);
}
beforeEach(() => { mocks.admin=true; mocks.rpc.mockReset().mockResolvedValue({data:[],error:null}); });
afterEach(cleanup);
describe('admin Aegis journey UI', () => {
  it('filters by account and outcome on the server, not just the displayed page', async () => {
    mount(); await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Adresse e-mail ou identifiant du compte'),{target:{value:'client@example.test'}});
    fireEvent.click(screen.getByText('Rechercher'));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('admin_aegis_journey',{p_account:'client@example.test'}));
    fireEvent.change(screen.getByLabelText('Résultat'),{target:{value:'failure'}});
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('admin_aegis_journey',{p_account:'client@example.test',p_outcome:'failure'}));
  });
  it('does not fetch for a non-admin', async () => {
    mocks.admin=false; mount(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('shows failure instead of claiming an empty successful journey', async () => {
    mocks.rpc.mockResolvedValue({data:null,error:new Error('unavailable')}); mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Journal indisponible');
    expect(screen.queryByText(/Aucun événement enregistré pour ces filtres/)).toBeNull();
  });
  it('shows UTC precision and explicitly labels untrusted transport reports', async () => {
    mocks.rpc.mockResolvedValue({data:[{id:'1',occurred_at:'2026-10-13T12:10:20.123Z',user_id:'user',session_id:'session',device_ref:null,message_id:null,stage:'aegis_send_message',outcome:'failure',source:'aegis_gateway',evidence:'transport_report',error_code:'DEVICE_NOT_FOUND',request_id:'request',duration_ms:17}],error:null});
    mount(); expect(await screen.findByText('Tentative d’envoi Aegis')).toBeInTheDocument();
    expect(screen.getByText(/résultat déclaratif/)).toBeInTheDocument();
    expect(screen.getByText(/2026-10-13T12:10:20.123Z/)).toBeInTheDocument();
    expect(screen.getByText('DEVICE_NOT_FOUND')).toBeInTheDocument();
  });
});
