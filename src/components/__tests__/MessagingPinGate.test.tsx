import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  pinState: {} as any,
  setupPin: vi.fn(),
  verifyPin: vi.fn(),
  lock: vi.fn(),
  requestReset: vi.fn(),
  confirmReset: vi.fn(),
  updatePinMode: vi.fn(),
}));

vi.mock('@/hooks/useChatPin', () => ({
  useChatPin: () => mocks.pinState,
}));

import { MessagingPinGate } from '../MessagingPinGate';

function basePinState() {
  return {
    loaded: true,
    hasPin: true,
    unlocked: false,
    error: null,
    processing: false,
    pinMode: 'every_open',
    restoreRequired: false,
    pinFailedAttempts: 0,
    pinAttemptsRemaining: 5,
    pinRetryAfterSeconds: 0,
    pinLockedUntil: null,
    pinReleaseAttestationOk: false,
    setupPin: mocks.setupPin,
    verifyPin: mocks.verifyPin,
    lock: mocks.lock,
    requestReset: mocks.requestReset,
    confirmReset: mocks.confirmReset,
    updatePinMode: mocks.updatePinMode,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupPin.mockResolvedValue(true);
  mocks.verifyPin.mockResolvedValue(false);
  mocks.requestReset.mockResolvedValue(true);
  mocks.confirmReset.mockResolvedValue(true);
  mocks.updatePinMode.mockResolvedValue(true);
  mocks.pinState = basePinState();
});

describe('MessagingPinGate restore PIN hardening', () => {
  it('shows the dedicated restore screen with visible attempts and backoff', async () => {
    mocks.pinState = {
      ...basePinState(),
      restoreRequired: true,
      pinFailedAttempts: 2,
      pinAttemptsRemaining: 3,
      pinRetryAfterSeconds: 8,
    };

    render(
      <MessagingPinGate>
        <div>messages</div>
      </MessagingPinGate>,
    );

    expect(screen.getByText('Déverrouillage requis')).toBeInTheDocument();
    expect(screen.getByText('Déverrouillage requis pour restaurer vos messages chiffrés')).toBeInTheDocument();
    expect(screen.getByText('3 restantes')).toBeInTheDocument();
    expect(await screen.findByText(/Nouvelle tentative dans/)).toBeInTheDocument();
  });

  it('disables PIN entry while the server backoff is active', async () => {
    mocks.pinState = {
      ...basePinState(),
      restoreRequired: true,
      pinFailedAttempts: 1,
      pinAttemptsRemaining: 4,
      pinRetryAfterSeconds: 5,
    };

    const { container } = render(
      <MessagingPinGate>
        <div>messages</div>
      </MessagingPinGate>,
    );

    await screen.findByText(/Nouvelle tentative dans/);
    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(6);
    expect(inputs.every(input => input.disabled)).toBe(true);
  });

  it('submits one PIN verification after six digits when no backoff is active', async () => {
    const { container } = render(
      <MessagingPinGate>
        <div>messages</div>
      </MessagingPinGate>,
    );

    const inputs = Array.from(container.querySelectorAll('input'));
    ['1', '2', '3', '4', '5', '6'].forEach((digit, index) => {
      fireEvent.change(inputs[index], { target: { value: digit } });
    });

    await waitFor(() => {
      expect(mocks.verifyPin).toHaveBeenCalledTimes(1);
    });
    expect(mocks.verifyPin).toHaveBeenCalledWith('123456');
  });
});
