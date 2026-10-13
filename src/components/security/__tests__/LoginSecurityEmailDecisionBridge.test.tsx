import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/security/emailDecision', () => ({ completeEmailDecision: h.complete }));
import { LoginSecurityEmailDecisionBridge } from '../LoginSecurityEmailDecisionBridge';

beforeEach(() => {
  h.complete.mockReset().mockResolvedValue('same_session');
  window.history.replaceState(null, '', `/feed#loginSecurityToken=${'a'.repeat(64)}&loginSecurityDecision=approve`);
});
describe('email decision browser bridge', () => {
  it('explicitly notifies the approved original device before continuing', async () => {
    h.complete.mockResolvedValue('device_approved_same_session');
    render(<LoginSecurityEmailDecisionBridge />);
    expect(await screen.findByText('Appareil approuvé')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Continuer sur ForSure'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('notifies approval from an iOS mail browser but does not authorize that browser', async () => {
    h.complete.mockResolvedValue('device_approved_other_session');
    render(<LoginSecurityEmailDecisionBridge />);
    expect(await screen.findByText('Appareil approuvé')).toBeInTheDocument();
    expect(screen.getByText(/Ce lien ne connecte pas un autre navigateur/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Continuer sur ForSure'})).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('posts once in StrictMode, removes the token and releases only the confirmed original session', async () => {
    render(<StrictMode><LoginSecurityEmailDecisionBridge /></StrictMode>);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });
  it('guides an iOS mail browser back to the original browser without logging it in', async () => {
    h.complete.mockResolvedValue('other_session');
    render(<LoginSecurityEmailDecisionBridge />);
    expect(await screen.findByText('Connexion confirmée')).toBeInTheDocument();
    expect(screen.getByText(/Revenez dans le navigateur/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('shows a recoverable error rather than claiming success or spinning forever', async () => {
    h.complete.mockRejectedValueOnce(new Error('offline'));
    render(<LoginSecurityEmailDecisionBridge />);
    expect(await screen.findByText('Impossible de vérifier dans ce navigateur')).toBeInTheDocument();
    expect(screen.getByText(/a peut-être déjà été approuvée/)).toBeInTheDocument();
    expect(screen.queryByText('Connexion confirmée')).not.toBeInTheDocument();
    expect(screen.queryByText(/Le serveur n’a pas confirmé/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.complete).toHaveBeenCalledTimes(2);
  });
  it('does not submit an invalid link', () => {
    window.history.replaceState(null, '', '/feed#loginSecurityToken=invalid');
    render(<LoginSecurityEmailDecisionBridge />);
    expect(screen.getByText('Lien de confirmation incomplet')).toBeInTheDocument();
    expect(h.complete).not.toHaveBeenCalled();
  });
  it('keeps a server-confirmed refusal distinct from an unknown network result', async () => {
    h.complete.mockResolvedValue('denied');
    render(<LoginSecurityEmailDecisionBridge />);
    expect(await screen.findByText('Connexion refusée')).toBeInTheDocument();
    expect(screen.queryByText(/a peut-être déjà été approuvée/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name:'Réessayer'})).not.toBeInTheDocument();
  });
  it('does not describe a lost refusal response as a possible approval', async () => {
    window.history.replaceState(null, '', `/feed#loginSecurityToken=${'a'.repeat(64)}&loginSecurityDecision=deny`);
    h.complete.mockRejectedValue(new Error('offline'));
    render(<LoginSecurityEmailDecisionBridge />);
    expect(await screen.findByText(/Votre refus a peut-être déjà été enregistré/)).toBeInTheDocument();
    expect(screen.queryByText(/connexion a peut-être déjà été approuvée/)).not.toBeInTheDocument();
  });
});
