import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { E2EEPinUnlockModal } from '../E2EEPinUnlockModal';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/components/MessagingPinGate', () => ({
  MessagingPinGate: ({ children }: { children: ReactNode }) => (
    <div data-testid="pin-gate">{children}</div>
  ),
}));

beforeEach(() => {
  sessionStorage.clear();
});

describe('E2EEPinUnlockModal', () => {
  it('opens automatically when resync requires PIN unlock', async () => {
    render(<E2EEPinUnlockModal />);

    act(() => {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
        detail: {
          userId: 'user-1',
          reason: 'identity_republish_pin_required',
          message: 'Déverrouillage requis pour restaurer vos messages chiffrés',
        },
      }));
    });

    expect(await screen.findByText('Déverrouillage requis pour restaurer vos messages chiffrés')).toBeInTheDocument();
    expect(screen.getByTestId('pin-gate')).toBeInTheDocument();
  });

  it('reopens from the pending session marker after a remount', async () => {
    sessionStorage.setItem(
      'forsure:e2ee-pin-unlock-required:user-1',
      JSON.stringify({
        at: Date.now(),
        detail: {
          userId: 'user-1',
          reason: 'local_identity_missing_chat_pin_backup',
          message: 'Déverrouillage requis pour restaurer vos messages chiffrés',
        },
      }),
    );

    render(<E2EEPinUnlockModal />);

    expect(await screen.findByText('Déverrouillage requis pour restaurer vos messages chiffrés')).toBeInTheDocument();
  });

  it('closes when keys are unlocked', async () => {
    render(<E2EEPinUnlockModal />);

    act(() => {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
        detail: { userId: 'user-1' },
      }));
    });
    expect(await screen.findByText('Déverrouillage requis pour restaurer vos messages chiffrés')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Déverrouillage requis pour restaurer vos messages chiffrés')).not.toBeInTheDocument();
    });
  });
});
