import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const deviceId = `dev_${'a'.repeat(32)}`;
  return {
    deviceId, journal: null as unknown, currentId: null as string | null,
    row: null as Record<string, unknown> | null,
    read: vi.fn(), begin: vi.fn(), complete: vi.fn(), cancel: vi.fn(),
    deleteSigning: vi.fn(), deleteKx: vi.fn(), signing: vi.fn(), kx: vi.fn(),
    restoreIos: vi.fn(), restoreAndroid: vi.fn(),
  };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const query = { select: () => query, eq: () => query, abortSignal: () => query, maybeSingle: () => h.read() };
  return query;
} } }));
vi.mock('@/lib/api/deviceRpcTimeout', () => ({ runDeviceRpcWithTimeout: (_: string, op: (s: AbortSignal) => unknown) => op(new AbortController().signal) }));
vi.mock('@/lib/device-manager/sessionGate', () => ({ requireAuthenticatedDeviceSession: vi.fn() }));
vi.mock('@/lib/crypto/crossTabLock', () => ({ runCrossTabExclusive: (_: string, op: () => unknown) => op() }));
vi.mock('@/lib/crypto/deviceEnrollmentJournal', () => ({
  readEnrollmentJournal: async () => h.journal,
  writeEnrollmentJournal: async (_: string, value: unknown) => { h.journal = value; },
  clearEnrollmentJournal: async () => { h.journal = null; },
}));
vi.mock('@/lib/messaging/currentDevice', () => ({
  setCurrentDeviceUserScope: vi.fn(), peekCurrentDeviceId: () => h.currentId,
  setCurrentDeviceId: (id: string) => (h.currentId = id),
  beginExplicitDeviceEnrollment: vi.fn(), getCurrentDeviceLabel: () => 'Test', getCurrentPlatform: () => 'web',
}));
vi.mock('@/lib/crypto/serverDeviceEnrollment', () => ({
  beginServerAssignedDeviceEnrollment: h.begin,
  completeServerAssignedDeviceEnrollment: h.complete,
  cancelServerAssignedDeviceEnrollment: h.cancel,
}));
vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: h.signing, getOrCreateDeviceIdentity: h.signing, deleteDeviceIdentity: h.deleteSigning,
}));
vi.mock('@/lib/crypto/deviceKx', () => ({
  loadDeviceKxKey: h.kx, getOrCreateDeviceKxKey: h.kx, deleteDeviceKxKey: h.deleteKx,
}));
vi.mock('@/platforms/ios/iosDeviceReuse', () => ({ adoptReusableIosDevice: async () => null, resolveExistingIosDevice: async () => null }));
vi.mock('@/platforms/android/androidDeviceReuse', () => ({ adoptReusableAndroidDevice: async () => null, resolveExistingAndroidDevice: async () => null }));
vi.mock('@/platforms/ios/iosDeviceVaultRestore', () => ({ ensureIosDeviceVaultRestored: h.restoreIos }));
vi.mock('@/platforms/android/androidDeviceVault', () => ({ restoreAndroidDeviceVault: h.restoreAndroid }));
vi.mock('@/platforms/ios/iosRpcErrorLog', () => ({ recordIosRpcError: vi.fn() }));
vi.mock('@/lib/crypto/deviceApprovalDecision', () => ({}));
vi.mock('@/lib/crypto/deviceAccountBinding', () => ({}));
vi.mock('@/lib/crypto/libsignalProvisioning', () => ({}));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({}));
vi.mock('@/lib/crypto/deviceLinkTrust', () => ({}));
vi.mock('@/lib/messaging/fanoutRouteCache', () => ({}));
vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({}));
vi.mock('@/lib/crypto/libsignalSessionFreshness', () => ({}));
vi.mock('@/lib/device-manager/deviceFinalizationTrace', () => ({
  traceFinalizationOperation: (_: string, op: () => unknown) => op(),
  getCurrentDeviceFinalizationTraceId: () => null, traceDeviceKeyChecks: vi.fn(),
}));
import { deviceApi } from '../deviceApi';

function staged() {
  h.row = { device_id: h.deviceId, approval_status: 'pending', is_active: false,
    device_signing_key: 'signing', device_public_key: 'exchange' };
}

describe('enrollment transaction recovery (real deviceApi, fake network)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.journal = null; h.row = null; h.currentId = null;
    h.begin.mockResolvedValue({ deviceId: h.deviceId, challengeId: 'challenge', nonce: 'nonce', expiresAt: '2099-01-01' });
    h.complete.mockImplementation(async () => { staged(); return h.deviceId; });
    h.cancel.mockResolvedValue({ status: 'completed', deviceId: h.deviceId });
    h.read.mockImplementation(async () => ({ data: h.row, error: null }));
    h.signing.mockResolvedValue({ publicB64: 'signing' });
    h.kx.mockResolvedValue({ publicB64: 'exchange' });
    h.restoreIos.mockResolvedValue('not_needed');
    h.restoreAndroid.mockResolvedValue(false);
  });

  it('finishes a healthy enrollment and removes only its journal', async () => {
    expect((await deviceApi.enroll('alice')).approvalStatus).toBe('pending');
    expect(h.journal).toBeNull();
    expect(h.deleteSigning).not.toHaveBeenCalled();
    expect(h.deleteKx).not.toHaveBeenCalled();
  });

  it('preserves keys after a failed read following successful completion; retries the same device', async () => {
    h.read.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await expect(deviceApi.enroll('alice')).rejects.toThrow('DEVICE_LOOKUP_FAILED');
    expect(h.journal).not.toBeNull();
    expect(h.deleteSigning).not.toHaveBeenCalled();
    expect(h.deleteKx).not.toHaveBeenCalled();
    expect((await deviceApi.getState('alice')).requiresExplicitEnrollment).toBe(false);
    expect((await deviceApi.enroll('alice')).deviceId).toBe(h.deviceId);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('uses the completed settlement after a lost completion response, without deleting keys', async () => {
    h.complete.mockImplementation(async () => { staged(); throw new Error('response lost'); });
    expect((await deviceApi.enroll('alice')).deviceId).toBe(h.deviceId);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.deleteSigning).not.toHaveBeenCalled();
    expect(h.deleteKx).not.toHaveBeenCalled();
  });

  it('preserves uncertain enrollment and resumes it after a module reload', async () => {
    h.complete.mockImplementation(async () => { staged(); throw new Error('offline'); });
    h.cancel.mockRejectedValue(new Error('offline'));
    await expect(deviceApi.enroll('alice')).rejects.toThrow('offline');
    expect(h.journal).not.toBeNull();
    vi.resetModules();
    const reloaded = (await import('../deviceApi')).deviceApi;
    expect((await reloaded.enroll('alice')).deviceId).toBe(h.deviceId);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.deleteSigning).not.toHaveBeenCalled();
  });

  it('deletes provisional keys only after confirmed server cancellation', async () => {
    h.complete.mockRejectedValue(new Error('not committed'));
    h.cancel.mockResolvedValue({ status: 'cancelled', deviceId: h.deviceId });
    await expect(deviceApi.enroll('alice')).rejects.toThrow('not committed');
    expect(h.deleteSigning).toHaveBeenCalledWith('alice', h.deviceId);
    expect(h.deleteKx).toHaveBeenCalledWith(h.deviceId, 'alice');
    expect(h.journal).toBeNull();
  });

  it('does not generate replacement keys when the server identity differs', async () => {
    staged(); h.currentId = h.deviceId;
    h.signing.mockResolvedValue({ publicB64: 'wrong' });
    await expect(deviceApi.enroll('alice')).rejects.toThrow('DEVICE_AUTO_APPROVAL_LOCAL_IDENTITY_INVALID');
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.deleteSigning).not.toHaveBeenCalled();
  });

  it('deduplicates simultaneous enrollment calls', async () => {
    await Promise.all([deviceApi.enroll('alice'), deviceApi.enroll('alice')]);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it.each(['ios', 'android'])('restores the exact approved vault on %s before reconciling a completed enrollment', async (platform) => {
    staged(); h.currentId = h.deviceId;
    h.row!.approval_status = 'approved'; h.row!.binding_status = 'bound'; h.row!.is_active = true;
    h.journal = { deviceId: h.deviceId };
    h.signing.mockResolvedValueOnce(null);
    h.kx.mockResolvedValueOnce(null);
    if (platform === 'ios') h.restoreIos.mockResolvedValue('restored');
    else h.restoreAndroid.mockResolvedValue(true);
    expect((await deviceApi.enroll('alice')).deviceId).toBe(h.deviceId);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.deleteSigning).not.toHaveBeenCalled();
    expect(h.journal).toBeNull();
  });

  it('preserves a completed journal when the original device keys cannot be restored', async () => {
    staged(); h.currentId = h.deviceId; h.journal = { deviceId: h.deviceId };
    h.signing.mockResolvedValue(null);
    await expect(deviceApi.enroll('alice')).rejects.toThrow('DEVICE_AUTO_APPROVAL_LOCAL_IDENTITY_INVALID');
    expect(h.journal).not.toBeNull();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.deleteSigning).not.toHaveBeenCalled();
  });
});
