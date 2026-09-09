import { describe, expect, it } from 'vitest';
import { resolveDeviceLifecycleState } from '@/lib/device-manager/deviceLifecycleMachine';

const approvedDevice = {
  deviceId: `dev_${'a'.repeat(32)}`,
  approvalStatus: 'approved' as const,
  bindingStatus: 'bound' as const,
  routingStatus: 'ready' as const,
  isActive: true,
  revokedAt: null,
};

describe('device lifecycle without PIN protection', () => {
  it('reaches messaging ready when the cryptographic backend is ready', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: approvedDevice,
      deviceIdStatus: 'ok',
      pinUnlocked: false,
      pinRequired: false,
      accountSyncPhase: 'idle',
    })).toEqual({ state: 'MESSAGING_READY', reason: 'ready' });
  });

  it('keeps the PIN lock when protection is explicitly enabled', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: approvedDevice,
      deviceIdStatus: 'ok',
      pinUnlocked: false,
      pinRequired: true,
      accountSyncPhase: 'idle',
    })).toEqual({ state: 'APPROVED_LOCKED', reason: 'awaiting_pin_unlock' });
  });
});
