import { describe, expect, it } from 'vitest';
import { resolveDeviceLifecycleState } from '@/lib/device-manager/deviceLifecycleMachine';

const readyDevice = {
  deviceId: `dev_${'a'.repeat(32)}`,
  approvalStatus: 'approved' as const,
  bindingStatus: 'bound' as const,
  routingStatus: 'ready' as const,
  lifecycleStatus: 'ready' as const,
  isActive: true,
  revokedAt: null,
};

describe('canonical device lifecycle order', () => {
  it('reaches messaging ready only with lifecycle ready and account sync ready', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: readyDevice,
      deviceIdStatus: 'ok',
      pinUnlocked: true,
      pinRequired: true,
      accountSyncPhase: 'ready',
    })).toEqual({ state: 'MESSAGING_READY', reason: 'ready' });
  });

  it('never reaches ready without PIN unlock', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: readyDevice,
      deviceIdStatus: 'ok',
      pinUnlocked: false,
      pinRequired: true,
      accountSyncPhase: 'ready',
    })).toEqual({ state: 'APPROVED_LOCKED', reason: 'awaiting_pin_unlock' });
  });

  it('never reaches ready without a successful account sync', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: readyDevice,
      deviceIdStatus: 'ok',
      pinUnlocked: true,
      pinRequired: true,
      accountSyncPhase: 'idle',
    })).toEqual({ state: 'ACCOUNT_KEY_SYNC', reason: 'account_sync_running' });
  });

  it('surfaces a failed account sync instead of opening messaging', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: readyDevice,
      deviceIdStatus: 'ok',
      pinUnlocked: true,
      pinRequired: true,
      accountSyncPhase: 'failed',
    })).toEqual({ state: 'ACCOUNT_KEY_SYNC', reason: 'account_sync_failed' });
  });

  it('resumes finalisation when routing is ready but lifecycle is not', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: { ...readyDevice, lifecycleStatus: 'syncing' },
      deviceIdStatus: 'ok',
      pinUnlocked: true,
      pinRequired: true,
      accountSyncPhase: 'ready',
    })).toEqual({ state: 'ACCOUNT_KEY_SYNC', reason: 'device_synchronization_pending' });
  });

  it('fails closed on a revoked lifecycle status', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: { ...readyDevice, lifecycleStatus: 'revoked' },
      deviceIdStatus: 'ok',
      pinUnlocked: true,
      pinRequired: true,
      accountSyncPhase: 'ready',
    })).toEqual({ state: 'LINK_REQUIRED', reason: 'device_revoked' });
  });

  it('requires the PIN before binding and key setup', () => {
    expect(resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: { ...readyDevice, bindingStatus: 'pending', routingStatus: null, lifecycleStatus: 'approved' },
      deviceIdStatus: 'ok',
      pinUnlocked: false,
      pinRequired: true,
      accountSyncPhase: 'idle',
    })).toEqual({ state: 'APPROVED_LOCKED', reason: 'awaiting_pin_unlock' });
  });
});
