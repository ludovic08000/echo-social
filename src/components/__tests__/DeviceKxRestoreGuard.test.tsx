import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  ensureAutoKeyProvisioning: vi.fn(),
  resetAutoKeyProvisioningCache: vi.fn(),
  resetCurrentDeviceProvisioning: vi.fn(),
  startRealtimeKeySync: vi.fn(),
  logCryptoError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/lib/crypto/autoKeyProvisioning', () => ({
  ensureAutoKeyProvisioning: mocks.ensureAutoKeyProvisioning,
  resetAutoKeyProvisioningCache: mocks.resetAutoKeyProvisioningCache,
  resetCurrentDeviceProvisioning: mocks.resetCurrentDeviceProvisioning,
}));

vi.mock('@/lib/crypto/realtimeKeySync', () => ({
  startRealtimeKeySync: mocks.startRealtimeKeySync,
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: mocks.logCryptoError,
}));

import { DeviceKxRestoreGuard } from '../DeviceKxRestoreGuard';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startRealtimeKeySync.mockReturnValue({ stop: vi.fn() });
  mocks.ensureAutoKeyProvisioning.mockResolvedValue({
    status: 'restore_required',
    reason: 'server_identity_exists_local_missing',
    deviceId: 'device-old',
  });
  mocks.resetCurrentDeviceProvisioning.mockResolvedValue({
    status: 'ready',
    reason: 'device_crypto_provisioned',
    oldDeviceId: 'device-old',
    newDeviceId: 'device-new',
  });
});

describe('DeviceKxRestoreGuard recovery modal', () => {
  it('shows the required restore modal when server/local device keys mismatch', async () => {
    render(<DeviceKxRestoreGuard />, { wrapper: MemoryRouter });

    expect(await screen.findByText('Cet appareil doit restaurer ses clés')).toBeInTheDocument();
    expect(screen.getByText('Restaurer mes clés')).toBeInTheDocument();
    expect(screen.getByText('Réinitialiser cet appareil')).toBeInTheDocument();
  });

  it('runs the restore action and closes when provisioning becomes ready', async () => {
    mocks.ensureAutoKeyProvisioning
      .mockResolvedValueOnce({
        status: 'restore_required',
        reason: 'server_identity_exists_local_missing',
        deviceId: 'device-old',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        reason: 'device_crypto_provisioned',
        deviceId: 'device-old',
      });

    render(<DeviceKxRestoreGuard />, { wrapper: MemoryRouter });

    fireEvent.click(await screen.findByText('Restaurer mes clés'));

    await waitFor(() => {
      expect(mocks.ensureAutoKeyProvisioning).toHaveBeenCalledWith('user-1', {
        reason: 'restore_modal_action',
        force: true,
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Cet appareil doit restaurer ses clés')).not.toBeInTheDocument();
    });
  });

  it('can reset the local device provisioning after restore is impossible', async () => {
    mocks.ensureAutoKeyProvisioning
      .mockResolvedValueOnce({
        status: 'restore_required',
        reason: 'server_identity_exists_local_missing',
        deviceId: 'device-old',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        reason: 'device_crypto_provisioned',
        deviceId: 'device-new',
      });

    render(<DeviceKxRestoreGuard />, { wrapper: MemoryRouter });

    fireEvent.click(await screen.findByText('Réinitialiser cet appareil'));

    await waitFor(() => {
      expect(mocks.resetCurrentDeviceProvisioning).toHaveBeenCalledWith('user-1');
    });
    await waitFor(() => {
      expect(screen.queryByText('Cet appareil doit restaurer ses clés')).not.toBeInTheDocument();
    });
  });
});
