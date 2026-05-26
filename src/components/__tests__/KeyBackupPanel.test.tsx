import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  hasBackup: vi.fn(),
  hasLocalKeys: vi.fn(),
  isAnyBackupSyncActive: vi.fn(),
  syncAvailableBackupsToServer: vi.fn(),
  resyncE2EE: vi.fn(),
  createLinkRequest: vi.fn(),
  approveLinkRequest: vi.fn(),
  claimApprovedLink: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/hooks/useSecureBackup', () => ({
  useSecureBackup: () => ({
    createBackup: mocks.createBackup,
    restoreBackup: mocks.restoreBackup,
    hasBackup: mocks.hasBackup,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useDeviceLink', () => ({
  useDeviceLink: () => ({
    createLinkRequest: mocks.createLinkRequest,
    approveLinkRequest: mocks.approveLinkRequest,
    claimApprovedLink: mocks.claimApprovedLink,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  isAnyBackupSyncActive: mocks.isAnyBackupSyncActive,
  syncAvailableBackupsToServer: mocks.syncAvailableBackupsToServer,
  hasLocalKeys: mocks.hasLocalKeys,
}));

vi.mock('@/lib/crypto/resyncE2EE', () => ({
  resyncE2EE: mocks.resyncE2EE,
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => <svg data-testid="qr" />,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { KeyBackupPanel } from '../KeyBackupPanel';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasBackup.mockResolvedValue(false);
  mocks.hasLocalKeys.mockResolvedValue(true);
  mocks.isAnyBackupSyncActive.mockReturnValue(true);
  mocks.createBackup.mockResolvedValue('FSR-RECOVERY-KEY-TEST');
  mocks.restoreBackup.mockResolvedValue(true);
});

describe('KeyBackupPanel recovery key flow', () => {
  it('creates and displays a recovery key backup', async () => {
    render(<KeyBackupPanel />);

    const button = await screen.findByText('Creer une cle de recuperation');
    await waitFor(() => expect(button.closest('button')).not.toBeDisabled());
    fireEvent.click(button);

    await waitFor(() => expect(mocks.createBackup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('FSR-RECOVERY-KEY-TEST')).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Cle de recuperation creee');
  });

  it('restores with a recovery key and announces keys restored', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<KeyBackupPanel />);

    const input = await screen.findByPlaceholderText('Cle de recuperation');
    fireEvent.change(input, { target: { value: 'FSR-RECOVERY-KEY-TEST' } });
    fireEvent.click(screen.getByText('Restaurer'));

    await waitFor(() => {
      expect(mocks.restoreBackup).toHaveBeenCalledWith('FSR-RECOVERY-KEY-TEST');
    });
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'forsure-keys-restored' }));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'forsure-decrypt-retry' }));
  });
});
