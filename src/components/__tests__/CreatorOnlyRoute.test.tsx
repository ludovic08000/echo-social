import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useProfile: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: harness.useAuth,
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: harness.useProfile,
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

import { CreatorOnlyRoute } from '@/components/ProtectedRoute';

describe('CreatorOnlyRoute', () => {
  beforeEach(() => {
    harness.useAuth.mockReturnValue({ user: { id: 'user-1' }, loading: false });
  });

  it('renders creator tools for a creator account', () => {
    harness.useProfile.mockReturnValue({
      data: { is_creator: true, age_verification_status: 'verified' },
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={['/ads']}>
        <Routes>
          <Route path="/ads" element={<CreatorOnlyRoute><div>Ads Manager</div></CreatorOnlyRoute>} />
          <Route path="/creator" element={<div>Creator upgrade</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Ads Manager')).toBeInTheDocument();
  });

  it('redirects a standard account to the creator upgrade route', () => {
    harness.useProfile.mockReturnValue({
      data: { is_creator: false, age_verification_status: 'verified' },
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={['/ai-agents']}>
        <Routes>
          <Route path="/ai-agents" element={<CreatorOnlyRoute><div>AI Agents</div></CreatorOnlyRoute>} />
          <Route path="/creator" element={<div>Creator upgrade</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Creator upgrade')).toBeInTheDocument();
    expect(screen.queryByText('AI Agents')).not.toBeInTheDocument();
  });
});
