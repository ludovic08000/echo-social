import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const authHarness = vi.hoisted(() => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: authHarness.useAuth,
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: null, isLoading: false }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('@/lib/authRecovery', () => ({
  detectAndStoreRecoveryFromHash: () => false,
  isRecoveryPending: () => false,
  setRecoveryFlag: vi.fn(),
}));

import { ProtectedRoute, PublicOnlyRoute } from '@/components/ProtectedRoute';

authHarness.useAuth.mockReset();

describe('PublicOnlyRoute', () => {
  it('opens the feed immediately while approved account crypto restores in background', () => {
    authHarness.useAuth.mockReturnValue({
      user: { id: 'user-1' },
      loading: false,
      cryptoRestoring: true,
    });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route
            path="/login"
            element={(
              <PublicOnlyRoute>
                <div>Connexion</div>
              </PublicOnlyRoute>
            )}
          />
          <Route path="/feed" element={<div>Feed ForSure</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Feed ForSure')).toBeInTheDocument();
    expect(screen.queryByText('Connexion')).not.toBeInTheDocument();
    expect(screen.queryByText('Restauration du coffre chiffré…')).not.toBeInTheDocument();
  });
});

describe('ProtectedRoute', () => {
  it('keeps the feed visible while approved Aegis restoration runs in background', () => {
    authHarness.useAuth.mockReturnValue({
      user: { id: 'user-1' },
      loading: false,
      cryptoRestoring: true,
    });

    render(
      <MemoryRouter initialEntries={['/feed']}>
        <Routes>
          <Route
            path="/feed"
            element={(
              <ProtectedRoute>
                <div>Feed ForSure</div>
              </ProtectedRoute>
            )}
          />
          <Route path="/login" element={<div>Connexion</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Feed ForSure')).toBeInTheDocument();
    expect(screen.queryByText('Restauration du coffre chiffré…')).not.toBeInTheDocument();
  });
});
