import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'alice' }, loginSecurity: { status: 'checking' } },
  get: vi.fn(), reset: vi.fn(), scope: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => h.auth }));
vi.mock('@/lib/device-manager/deviceLifecycleController', () => ({
  configureDeviceLifecycleDeps: vi.fn(), getDeviceLifecycleController: h.get,
  resetDeviceLifecycleControllers: h.reset,
}));
vi.mock('@/lib/messaging/currentDevice', () => ({ setCurrentDeviceUserScope: h.scope }));
vi.mock('@/integrations/supabase/client', () => ({}));
vi.mock('@/lib/api/deviceApi', () => ({}));
vi.mock('@/lib/api/cryptoApi', () => ({}));
vi.mock('@/lib/crypto/deviceApprovalDecision', () => ({}));
vi.mock('@/lib/crypto/accountKeySync', () => ({}));
vi.mock('@/lib/messaging/accountSyncBarrier', () => ({}));
vi.mock('@/lib/device-manager/deviceFinalizationTrace', () => ({}));
vi.mock('@/lib/device-manager/pinUnlockSignal', () => ({}));
vi.mock('@/platforms/ios/iosLifecycleAdapter', () => ({ syncIosDeviceAdapter: vi.fn() }));
vi.mock('@/platforms/android/androidLifecycleAdapter', () => ({ syncAndroidDeviceAdapter: vi.fn() }));
import { useDeviceLifecycle } from '../useDeviceLifecycle';

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.loginSecurity.status = 'checking';
  h.get.mockReturnValue({
    getSnapshot: () => ({ state: 'MESSAGING_READY', canRunCryptoRuntime: true, record: null }),
    subscribe: () => h.unsubscribe,
  });
});
describe('login approval precedes device lifecycle initialization', () => {
  it.each(['checking', 'pending', 'error', 'denied', 'signed_out'])('does not start device work for %s', (status) => {
    h.auth.loginSecurity.status = status;
    const { result } = renderHook(() => useDeviceLifecycle());
    expect(h.get).not.toHaveBeenCalled();
    expect(result.current.canRunCryptoRuntime).toBe(false);
  });
  it('initializes after email approval and closes immediately if authorization is removed', () => {
    const { result, rerender } = renderHook(() => useDeviceLifecycle());
    expect(h.get).not.toHaveBeenCalled();
    h.auth.loginSecurity.status = 'approved'; rerender();
    expect(h.get).toHaveBeenCalledWith('alice');
    expect(result.current.canRunCryptoRuntime).toBe(true);
    h.auth.loginSecurity.status = 'denied'; rerender();
    expect(result.current.canRunCryptoRuntime).toBe(false);
    expect(h.unsubscribe).toHaveBeenCalled();
    expect(h.reset).toHaveBeenCalled();
  });
});
