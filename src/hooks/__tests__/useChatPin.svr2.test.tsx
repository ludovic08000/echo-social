import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  runTxOn: vi.fn(),
  reqToPromise: vi.fn(),
  hasRawIdentityKeys: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    functions: {
      invoke: mocks.invoke,
    },
  },
}));

vi.mock('@/lib/crypto/indexedDbTx', () => ({
  runTxOn: mocks.runTxOn,
  reqToPromise: mocks.reqToPromise,
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  hasRawIdentityKeys: mocks.hasRawIdentityKeys,
}));

import { useChatPin } from '../useChatPin';

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.rpc.mockImplementation((name: string) => {
    if (name === 'has_chat_pin') return Promise.resolve({ data: true, error: null });
    if (name === 'get_chat_pin_settings') return Promise.resolve({ data: { pin_mode: 'every_open' }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  mocks.runTxOn.mockResolvedValue(null);
  mocks.reqToPromise.mockResolvedValue(null);
  mocks.hasRawIdentityKeys.mockResolvedValue(false);
});

describe('useChatPin SVR2 release hardening', () => {
  it('reads non-2xx PIN counters from the edge function response', async () => {
    const response = new Response(JSON.stringify({
      ok: false,
      error: 'PIN incorrect',
      failedAttempts: 2,
      attemptsRemaining: 3,
      retryAfterSeconds: 4,
      lockedUntil: null,
    }), { status: 403 });
    mocks.invoke.mockResolvedValue({ data: null, error: { context: response } });

    const { result } = renderHook(() => useChatPin());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let ok = true;
    await act(async () => {
      ok = await result.current.verifyPin('123456');
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe('PIN incorrect');
    expect(result.current.pinFailedAttempts).toBe(2);
    expect(result.current.pinAttemptsRemaining).toBe(3);
    expect(result.current.pinRetryAfterSeconds).toBe(4);
  });

  it('refuses to release a backup PIN secret without HMAC attestation', async () => {
    mocks.invoke.mockResolvedValue({
      data: {
        ok: true,
        backupSecret: 'backup-secret-without-attestation',
        salt: 'ignored',
      },
      error: null,
    });

    const { result } = renderHook(() => useChatPin());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let ok = true;
    await act(async () => {
      ok = await result.current.verifyPin('123456');
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe('Attestation PIN invalide. Restauration refusee.');
    expect(result.current.pinReleaseAttestationOk).toBe(false);
  });
});
