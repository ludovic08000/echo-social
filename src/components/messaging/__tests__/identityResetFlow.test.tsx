/**
 * Tests du flux explicite de réinitialisation d'identité.
 * Invariant : aucune mutation cryptographique sans action utilisateur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const resetMock = vi.fn();
const inspectMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'a@b.c' } }),
}));

vi.mock('@/lib/crypto/accountCryptoState', () => ({
  inspectAccountCryptoState: (...args: unknown[]) => inspectMock(...args),
}));

vi.mock('@/lib/crypto/explicitIdentityReset', () => ({
  resetUnrecoverableIdentityWithPassword: (...args: unknown[]) => resetMock(...args),
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  initAccountKeySync: vi.fn(async () => 'restored'),
  hasLocalKeys: vi.fn(async () => false),
}));

vi.mock('@/lib/crypto/aegisRecoveryVault', () => ({
  restoreAegisRecoveryVault: vi.fn(async () => ({ status: 'restored' })),
}));

import {
  IdentityResetScreen,
  IdentityRestoreScreen,
  IdentityInconsistentScreen,
} from '@/components/messaging/IdentityRecoveryGate';
import {
  acquireRecoveryDialog,
  getRecoveryDialogOwner,
  __test__ as coordinatorTest,
} from '@/lib/crypto/recoveryDialogCoordinator';

const RESET_LABEL = 'Créer une nouvelle identité sécurisée';

describe('IdentityResetScreen', () => {
  beforeEach(() => {
    resetMock.mockReset();
    inspectMock.mockReset();
    coordinatorTest.reset();
  });

  it('n’appelle jamais la réinitialisation automatiquement', async () => {
    render(<IdentityResetScreen onSuccess={vi.fn()} onRetryRestore={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(RESET_LABEL).length).toBeGreaterThan(0));
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('exige le mot de passe et la case de confirmation', async () => {
    render(<IdentityResetScreen onSuccess={vi.fn()} onRetryRestore={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: RESET_LABEL }));

    const submit = screen.getByRole('button', { name: RESET_LABEL });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Mot de passe du compte'), {
      target: { value: 'secret' },
    });
    expect(screen.getByRole('button', { name: RESET_LABEL })).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: RESET_LABEL })).not.toBeDisabled(),
    );
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('affiche l’erreur renvoyée et n’avance pas vers le PIN', async () => {
    resetMock.mockResolvedValue({ ok: false, code: 'invalid_password', message: 'Mot de passe incorrect.' });
    const onSuccess = vi.fn();
    render(<IdentityResetScreen onSuccess={onSuccess} onRetryRestore={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: RESET_LABEL }));
    fireEvent.change(screen.getByLabelText('Mot de passe du compte'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: RESET_LABEL }));

    await screen.findByText('Mot de passe incorrect.');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('appelle onSuccess une seule fois même en cas de double clic', async () => {
    let resolve!: (value: unknown) => void;
    resetMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const onSuccess = vi.fn();
    render(<IdentityResetScreen onSuccess={onSuccess} onRetryRestore={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: RESET_LABEL }));
    fireEvent.change(screen.getByLabelText('Mot de passe du compte'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('checkbox'));

    const submit = screen.getByRole('button', { name: RESET_LABEL });
    fireEvent.click(submit);
    fireEvent.click(submit);
    resolve({ ok: true, state: 'READY' });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(resetMock).toHaveBeenCalledTimes(1);
  });
});

describe('écrans par état', () => {
  beforeEach(() => coordinatorTest.reset());

  it('RESTORABLE_IDENTITY ne propose pas la réinitialisation', () => {
    render(<IdentityRestoreScreen onRestored={vi.fn()} />);
    expect(screen.queryByRole('button', { name: RESET_LABEL })).toBeNull();
  });

  it('INCONSISTENT reste bloqué sans création de clé', () => {
    render(<IdentityInconsistentScreen reason="server_inspection_incomplete" onRetry={vi.fn()} />);
    expect(screen.getByText(/incohérent/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: RESET_LABEL })).toBeNull();
  });
});

describe('coordinateur de fenêtres de récupération', () => {
  beforeEach(() => coordinatorTest.reset());

  it('n’autorise qu’un seul écran à la fois', () => {
    render(<IdentityResetScreen onSuccess={vi.fn()} onRetryRestore={vi.fn()} />);
    expect(getRecoveryDialogOwner()).toBe('messaging-identity-gate');
    expect(acquireRecoveryDialog('e2ee-restore-prompt')).toBe(false);
  });
});
