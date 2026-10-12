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
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.complete).toHaveBeenCalledTimes(2);
  });
  it('does not submit an invalid link', () => {
    window.history.replaceState(null, '', '/feed#loginSecurityToken=invalid');
    render(<LoginSecurityEmailDecisionBridge />);
    expect(screen.getByText('Validation non confirmée')).toBeInTheDocument();
    expect(h.complete).not.toHaveBeenCalled();
  });
});
