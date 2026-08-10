import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const listDevices = vi.fn();
const getCurrentId = vi.fn();
const approve = vi.fn();
const reject = vi.fn();

vi.mock('@/lib/api/deviceApi', () => ({
  deviceApi: {
    listDevices: (...args: unknown[]) => listDevices(...args),
    getCurrentId: (...args: unknown[]) => getCurrentId(...args),
    approve: (...args: unknown[]) => approve(...args),
    reject: (...args: unknown[]) => reject(...args),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => undefined,
  },
}));

vi.mock('@/lib/crypto/deviceApprovalFingerprint', () => ({
  computeDeviceApprovalFingerprint: async () => '11111 22222 33333 44444 55555 66666',
  formatDeviceApprovalFingerprint: (f: string) => [f],
}));

import { usePendingDeviceApprovalRequests } from '@/hooks/usePendingDeviceApprovalRequests';

const READY = {
  deviceId: 'dev_ready',
  deviceRole: 'primary',
  lifecycleStatus: 'ready',
  approvalStatus: 'approved',
  bindingStatus: 'bound',
  routingStatus: 'ready',
  isActive: true,
  revokedAt: null,
  deviceName: 'Mac',
  platform: 'web',
  devicePublicKey: 'x',
  deviceSigningKey: 'y',
  approvalChallengeId: null,
  approvedByDeviceId: null,
  id: '1',
  userAgent: null,
  approvalRequestedAt: null,
  lastSeenAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  staleAt: null,
  revokeReason: null,
} as never;

const PENDING = {
  ...(READY as object),
  deviceId: 'dev_pending',
  lifecycleStatus: 'pending',
  approvalStatus: 'pending',
  bindingStatus: 'pending',
  routingStatus: 'repairing',
  deviceName: 'iPhone',
  platform: 'ios',
  id: '2',
} as never;

describe('usePendingDeviceApprovalRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDevices.mockResolvedValue([READY, PENDING]);
  });

  it('shows the pending request on a ready approver device', async () => {
    getCurrentId.mockReturnValue('dev_ready');
    const { result } = renderHook(() => usePendingDeviceApprovalRequests());
    await waitFor(() => expect(result.current.canDecide).toBe(true));
    expect(result.current.requests).toHaveLength(1);
    expect(result.current.requests[0].deviceId).toBe('dev_pending');
    expect(result.current.requests[0].fingerprintLines).toHaveLength(1);
  });

  it('never offers self-approval on the pending device itself', async () => {
    getCurrentId.mockReturnValue('dev_pending');
    const { result } = renderHook(() => usePendingDeviceApprovalRequests());
    await waitFor(() => expect(listDevices).toHaveBeenCalled());
    await waitFor(() => expect(result.current.canDecide).toBe(false));
    expect(result.current.requests).toHaveLength(0);
  });

  it('calls the right API and clears the request after a decision', async () => {
    getCurrentId.mockReturnValue('dev_ready');
    approve.mockResolvedValue({});
    const { result } = renderHook(() => usePendingDeviceApprovalRequests());
    await waitFor(() => expect(result.current.requests).toHaveLength(1));

    listDevices.mockResolvedValue([READY]);
    await act(async () => {
      await result.current.decide('dev_pending', 'approve');
    });

    expect(approve).toHaveBeenCalledWith('user-1', 'dev_pending');
    expect(reject).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.requests).toHaveLength(0));
  });

  it('routes a refusal to deviceApi.reject and keeps errors visible', async () => {
    getCurrentId.mockReturnValue('dev_ready');
    reject.mockRejectedValue(new Error('DEVICE_APPROVAL_NOT_PENDING'));
    const { result } = renderHook(() => usePendingDeviceApprovalRequests());
    await waitFor(() => expect(result.current.requests).toHaveLength(1));

    let ok = true;
    await act(async () => {
      ok = await result.current.decide('dev_pending', 'reject');
    });

    expect(reject).toHaveBeenCalledWith('user-1', 'dev_pending');
    expect(ok).toBe(false);
    expect(result.current.error).toContain('DEVICE_APPROVAL_NOT_PENDING');
  });
});
