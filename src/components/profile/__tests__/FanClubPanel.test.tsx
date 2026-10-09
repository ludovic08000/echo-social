import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clubMocks = vi.hoisted(() => ({
  club: null as null | {
    creator_id: string;
    is_enabled: boolean;
    monthly_price_cents: number;
    description: string | null;
  },
  mySubscription: null as null | { status: string; amount_cents: number; current_period_end: string | null },
  members: [] as Array<{ fan_id: string; status: string; amount_cents: number }>,
  hasBadge: false,
}));

vi.mock('@/hooks/useFanClub', () => ({
  useFanClub: () => ({ data: clubMocks.club, isLoading: false }),
  useMyFanSubscription: () => ({ data: clubMocks.mySubscription }),
  useFanClubMembers: () => ({ data: clubMocks.members }),
  useUpdateFanClub: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useSubscribeToCreator: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock('@/hooks/useStripeSubscription', () => ({
  useStripeSubscription: () => ({ isCreatorSubscriber: clubMocks.hasBadge, loading: false }),
}));

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { FanClubPanel } from '@/components/profile/FanClubPanel';

describe('FanClubPanel', () => {
  beforeEach(() => {
    clubMocks.club = null;
    clubMocks.mySubscription = null;
    clubMocks.members = [];
    clubMocks.hasBadge = false;
  });

  it("bloque le club tant que le badge Créateur n'est pas payé", () => {
    render(<FanClubPanel creatorId="creator-1" creatorName="Alice" isOwnProfile />);
    expect(screen.getByText(/badge Créateur à 4,99/i)).toBeInTheDocument();
    expect(screen.queryByText(/Ouvrir mon club/i)).not.toBeInTheDocument();
  });

  it("propose le prix mensuel choisi au fan qui n'est pas abonné", () => {
    clubMocks.club = {
      creator_id: 'creator-1',
      is_enabled: true,
      monthly_price_cents: 299,
      description: 'Sons en avant-première',
    };
    render(<FanClubPanel creatorId="creator-1" creatorName="Alice" isOwnProfile={false} />);
    expect(screen.getByText('2,99 €/mois')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /S'abonner/i })).toBeInTheDocument();
  });

  it("confirme le fan déjà abonné sans lui relancer un paiement", () => {
    clubMocks.club = {
      creator_id: 'creator-1',
      is_enabled: true,
      monthly_price_cents: 299,
      description: null,
    };
    clubMocks.mySubscription = { status: 'active', amount_cents: 299, current_period_end: null };
    render(<FanClubPanel creatorId="creator-1" creatorName="Alice" isOwnProfile={false} />);
    expect(screen.getByText(/Vous êtes abonné/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /S'abonner/i })).not.toBeInTheDocument();
  });
});
