import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleHarness = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('@/hooks/useDeviceLifecycle', () => ({
  useDeviceLifecycle: () => lifecycleHarness.value,
}));

vi.mock('@/components/messaging/DeviceFinalizationDiagnostics', () => ({
  DeviceFinalizationDiagnostics: () => null,
  useFinalizationStall: () => false,
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
  });

  it('exposes the PIN/recovery gate only when approval requires the locked account key', () => {
    lifecycleHarness.value = { ...pendingLifecycle(null), state: 'ACCOUNT_RECOVERY_REQUIRED', canPromptForPin: true };

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
    lifecycleHarness.value = { ...pendingLifecycle(null), state: 'ACCOUNT_RECOVERY_REQUIRED', canPromptForPin: true };

    render(
      <DeviceApprovalGate>
        <div>Écran PIN ou restauration</div>
      </DeviceApprovalGate>,
    );

    expect(screen.getByText('Écran PIN ou restauration')).toBeInTheDocument();
    expect(screen.queryByText('Activation de cet appareil…')).not.toBeInTheDocument();
  });

  it.each(['NOT_AUTHENTICATED', 'DEVICE_STATE_LOOKUP_FAILED'])(
    'does not open recovery when a server error occurs: %s',
    (error) => {
      lifecycleHarness.value = { ...pendingLifecycle(error), state: 'ACCOUNT_RECOVERY_REQUIRED', canPromptForPin: true };

      render(
        <DeviceApprovalGate>
          <div>Écran PIN ou restauration</div>
        </DeviceApprovalGate>,
      );

      expect(screen.queryByText('Écran PIN ou restauration')).not.toBeInTheDocument();
      expect(screen.getByText(error)).toBeInTheDocument();
    },
  );

  it('does not expose the PIN gate for an unrelated approval failure', () => {
    lifecycleHarness.value = pendingLifecycle('NOT_AUTHENTICATED');

    render(
      <DeviceApprovalGate>
        <div>Écran PIN ou restauration</div>
      </DeviceApprovalGate>,
    );

    expect(screen.getByText('NOT_AUTHENTICATED')).toBeInTheDocument();
    expect(screen.queryByText('Écran PIN ou restauration')).not.toBeInTheDocument();
  });
});
