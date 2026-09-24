import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pinHarness = vi.hoisted(() => ({
  requestReset: vi.fn(),
  confirmReset: vi.fn(),
  setupPin: vi.fn(),
  verifyPin: vi.fn(),
}));

vi.mock('@/hooks/useChatPin', () => ({
  useChatPin: () => ({
    loaded: true,
    hasPin: true,
    unlocked: false,
    processing: false,
    error: null,
    pinMode: 'every_open',
    requestReset: pinHarness.requestReset,
    confirmReset: pinHarness.confirmReset,
    setupPin: pinHarness.setupPin,
    verifyPin: pinHarness.verifyPin,
    lock: vi.fn(),
    updatePinMode: vi.fn(),
  }),
}));

vi.mock('@/components/PinValidatedMessaging', () => ({
  PinValidatedMessaging: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/messaging/IdentityRecoveryGate', () => ({
  useAccountCryptoGate: () => ({
    loaded: true,
    inspection: { state: 'READY' },
    refresh: vi.fn(),
  }),
  IdentityInconsistentScreen: () => null,
  IdentityResetScreen: () => null,
  IdentityRestoreScreen: ({
    onRestored,
    onCancel,
    title = 'Restaurer votre identité sécurisée',
    description,
  }: {
    onRestored: () => void;
    onCancel?: () => void;
    title?: string;
    description?: string;
  }) => (
    <div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      <button type="button" onClick={onRestored}>Restauration réussie</button>
      {onCancel && <button type="button" onClick={onCancel}>Annuler la restauration</button>}
    </div>
  ),
}));

import { PinUnlockGate } from '@/components/messaging/PinUnlockGate';

async function openResetForm() {
  fireEvent.click(screen.getByRole('button', { name: 'PIN oublié' }));
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer le code de récupération' }));
  await screen.findByLabelText('Code reçu par email');
}

describe('PinUnlockGate secure reset', () => {
  beforeEach(() => {
    pinHarness.requestReset.mockReset().mockResolvedValue(true);
    pinHarness.confirmReset.mockReset().mockResolvedValue('success');
    pinHarness.setupPin.mockReset();
    pinHarness.verifyPin.mockReset();
  });

  it('sends the email code and the confirmed new PIN to the atomic reset hook', async () => {
    render(<PinUnlockGate><div>Messagerie</div></PinUnlockGate>);
    await openResetForm();

    fireEvent.change(screen.getByLabelText('Code reçu par email'), {
      target: { value: '12a34 56' },
    });
    fireEvent.change(screen.getByLabelText('Nouveau PIN à 6 chiffres'), {
      target: { value: '65x43 21' },
    });
    fireEvent.change(screen.getByLabelText('Confirmer le nouveau PIN'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le nouveau PIN' }));

    await waitFor(() => {
      expect(pinHarness.confirmReset).toHaveBeenCalledWith('123456', '654321');
    });
    expect(screen.getByText('Déverrouiller la messagerie')).toBeInTheDocument();
  });

  it('refuses mismatched replacement PINs before calling the hook', async () => {
    render(<PinUnlockGate><div>Messagerie</div></PinUnlockGate>);
    await openResetForm();

    fireEvent.change(screen.getByLabelText('Code reçu par email'), {
      target: { value: '123456' },
    });
    fireEvent.change(screen.getByLabelText('Nouveau PIN à 6 chiffres'), {
      target: { value: '654321' },
    });
    fireEvent.change(screen.getByLabelText('Confirmer le nouveau PIN'), {
      target: { value: '654320' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le nouveau PIN' }));

    expect(await screen.findByText('Les deux nouveaux PIN ne correspondent pas.'))
      .toBeInTheDocument();
    expect(pinHarness.confirmReset).not.toHaveBeenCalled();
  });

  it('restores the Master Key before retrying and preserves the email code and new PIN', async () => {
    pinHarness.confirmReset
      .mockResolvedValueOnce('master_key_restore_required')
      .mockResolvedValueOnce('success');

    render(<PinUnlockGate><div>Messagerie</div></PinUnlockGate>);
    await openResetForm();

    fireEvent.change(screen.getByLabelText('Code reçu par email'), {
      target: { value: '123456' },
    });
    fireEvent.change(screen.getByLabelText('Nouveau PIN à 6 chiffres'), {
      target: { value: '654321' },
    });
    fireEvent.change(screen.getByLabelText('Confirmer le nouveau PIN'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le nouveau PIN' }));

    expect(await screen.findByText('Déverrouiller la clé sécurisée')).toBeInTheDocument();
    expect(screen.getByText(/sans perdre vos messages ni votre identité Libsignal/i))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restauration réussie' }));

    expect(await screen.findByLabelText('Code reçu par email')).toHaveValue('123456');
    expect(screen.getByLabelText('Nouveau PIN à 6 chiffres')).toHaveValue('654321');
    expect(screen.getByLabelText('Confirmer le nouveau PIN')).toHaveValue('654321');
    expect(screen.getByText(/Clé sécurisée restaurée/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le nouveau PIN' }));
    await waitFor(() => expect(pinHarness.confirmReset).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Déverrouiller la messagerie')).toBeInTheDocument();
  });

  it('clears recovery secrets when leaving the reset flow', async () => {
    render(<PinUnlockGate><div>Messagerie</div></PinUnlockGate>);
    await openResetForm();

    fireEvent.change(screen.getByLabelText('Code reçu par email'), {
      target: { value: '123456' },
    });
    fireEvent.change(screen.getByLabelText('Nouveau PIN à 6 chiffres'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
    await openResetForm();

    expect(screen.getByLabelText('Code reçu par email')).toHaveValue('');
    expect(screen.getByLabelText('Nouveau PIN à 6 chiffres')).toHaveValue('');
    expect(screen.getByLabelText('Confirmer le nouveau PIN')).toHaveValue('');
  });
});
