import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleHarness = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

const cryptoHarness = vi.hoisted(() => ({
  value: {
    loaded: true,
    inspection: { state: 'READY' },
    refresh: vi.fn(),
  } as Record<string, unknown>,
}));

vi.mock('@/hooks/useDeviceLifecycle', () => ({
  useDeviceLifecycle: () => lifecycleHarness.value,
}));

vi.mock('@/components/messaging/DeviceFinalizationDiagnostics', () => ({
  DeviceFinalizationDiagnostics: () => null,
  useFinalizationStall: () => false,
}));

vi.mock('@/components/messaging/IdentityRecoveryGate', () => ({
  useAccountCryptoGate: () => cryptoHarness.value,
}));

import { DeviceApprovalGate } from '@/components/messaging/DeviceApprovalGate';

function pendingLifecycle(error: string | null) {
  return {
    loading: false,
    state: 'PENDING_APPROVAL',
    stage: 'idle',
    error,
    canPromptForPin: false,
    canStartEnrollment: false,
    retry: vi.fn(),
    startEnrollment: vi.fn(),
  };
}

describe('DeviceApprovalGate approval prerequisites', () => {
  beforeEach(() => {
    lifecycleHarness.value = pendingLifecycle(null);
    cryptoHarness.value = {
      loaded: true,
      inspection: { state: 'READY' },
      refresh: vi.fn(),
    };
  });

  it('exposes the PIN/recovery gate only when approval requires the locked account key', () => {
    lifecycleHarness.value = pendingLifecycle('PIN_UNLOCK_REQUIRED:account_key_locked');

    render(
      <DeviceApprovalGate>
        <div>Écran PIN ou restauration</div>
      </DeviceApprovalGate>,
    );

    expect(screen.getByText('Écran PIN ou restauration')).toBeInTheDocument();
    expect(screen.queryByText('Activation de cet appareil…')).not.toBeInTheDocument();
  });

  it('keeps an ordinary pending approval closed', () => {
    render(
      <DeviceApprovalGate>
        <div>Écran PIN ou restauration</div>
      </DeviceApprovalGate>,
    );

    expect(screen.getByText('Activation de cet appareil…')).toBeInTheDocument();
    expect(screen.queryByText('Écran PIN ou restauration')).not.toBeInTheDocument();
  });

  it('opens secure account recovery before approval when an existing identity is restorable', () => {
    cryptoHarness.value = {
      loaded: true,
      inspection: { state: 'RESTORABLE_IDENTITY' },
      refresh: vi.fn(),
    };

    render(
      <DeviceApprovalGate>
        <div>Écran PIN ou restauration</div>
      </DeviceApprovalGate>,
    );

    expect(screen.getByText('Écran PIN ou restauration')).toBeInTheDocument();
    expect(screen.queryByText('Activation de cet appareil…')).not.toBeInTheDocument();
  });

  it.each(['UNRECOVERABLE_SERVER_IDENTITY', 'INCONSISTENT'])(
    'exposes the fail-closed identity screen for %s instead of an endless approval spinner',
    (state) => {
      cryptoHarness.value = {
        loaded: true,
        inspection: { state },
        refresh: vi.fn(),
      };

      render(
        <DeviceApprovalGate>
          <div>Écran PIN ou restauration</div>
        </DeviceApprovalGate>,
      );

      expect(screen.getByText('Écran PIN ou restauration')).toBeInTheDocument();
      expect(screen.queryByText('Activation de cet appareil…')).not.toBeInTheDocument();
    },
  );

  it('does not expose the PIN gate for an unrelated approval failure', () => {
    lifecycleHarness.value = pendingLifecycle('NOT_AUTHENTICATED');
    cryptoHarness.value = {
      loaded: true,
      inspection: { state: 'RESTORABLE_IDENTITY' },
      refresh: vi.fn(),
    };

    render(
      <DeviceApprovalGate>
        <div>Écran PIN ou restauration</div>
      </DeviceApprovalGate>,
    );

    expect(screen.getByText('NOT_AUTHENTICATED')).toBeInTheDocument();
    expect(screen.queryByText('Écran PIN ou restauration')).not.toBeInTheDocument();
  });
});
