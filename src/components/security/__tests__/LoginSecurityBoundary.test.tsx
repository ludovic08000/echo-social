import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authHarness = vi.hoisted(() => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: authHarness.useAuth,
}));

import { LoginSecurityBoundary } from '@/components/security/LoginSecurityBoundary';

function authState(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'user-1', email: 'user@forsure.fans' },
    loading: false,
    cryptoRestoring: false,
    loginSecurity: { status: 'checking', session: null },
    refreshLoginSecurity: vi.fn(),
    resendLoginApprovalEmail: vi.fn(),
    signOut: vi.fn(),
    ...overrides,
  };
}

describe('LoginSecurityBoundary', () => {
  beforeEach(() => {
    authHarness.useAuth.mockReset();
  });

  it('keeps a first unknown session blocked without showing the old connection message', () => {
    authHarness.useAuth.mockReturnValue(authState());

    render(
      <LoginSecurityBoundary>
        <div>Espace privé</div>
      </LoginSecurityBoundary>,
    );

    expect(screen.queryByText('Espace privé')).not.toBeInTheDocument();
    expect(screen.getByText('Ouverture de ForSure')).toBeInTheDocument();
    expect(screen.queryByText('Vérification de la connexion')).not.toBeInTheDocument();
  });

  it('renders the application once the exact login session is approved', () => {
    authHarness.useAuth.mockReturnValue(authState({
      loginSecurity: {
        status: 'approved',
        session: { status: 'approved', sessionId: 'session-1' },
      },
    }));

    render(
      <LoginSecurityBoundary>
        <div>Espace privé</div>
      </LoginSecurityBoundary>,
    );

    expect(screen.getByText('Espace privé')).toBeInTheDocument();
    expect(screen.queryByText('Ouverture de ForSure')).not.toBeInTheDocument();
  });

  it('refreshes a pending approval immediately and when the tab regains focus', async () => {
    const refreshLoginSecurity = vi.fn().mockResolvedValue(undefined);
    authHarness.useAuth.mockReturnValue(authState({
      loginSecurity: {
        status: 'pending',
        session: { status: 'pending', sessionId: 'session-1' },
      },
      refreshLoginSecurity,
    }));

    render(
      <LoginSecurityBoundary>
        <div>Espace privé</div>
      </LoginSecurityBoundary>,
    );

    await waitFor(() => expect(refreshLoginSecurity).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(refreshLoginSecurity).toHaveBeenCalledTimes(2));
  });
});
