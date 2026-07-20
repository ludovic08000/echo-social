import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invalidateRoute: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(async () => 1),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('@/lib/messaging/fanoutRouteCache', () => ({
  invalidateFanoutRoute: mocks.invalidateRoute,
}));

vi.mock('@/lib/messaging/fanoutSessionTransaction', () => ({
  commitFanoutSessionTransaction: mocks.commit,
  rollbackFanoutSessionTransaction: mocks.rollback,
}));

import { sendMessageWithAegisRetry } from '../aegisSendRpc';
import type { FanoutCopyRow } from '../multiDeviceFanout';

const INITIAL: FanoutCopyRow[] = [{
  message_id: '11111111-1111-4111-8111-111111111111',
  recipient_user_id: '22222222-2222-4222-8222-222222222222',
  recipient_device_id: 'device-old-12345678',
  sender_user_id: '33333333-3333-4333-8333-333333333333',
  sender_device_id: 'sender-device-12345678',
  encrypted_body: 'aegis1.ratchet.session.dh.0.0.iv.ct',
}];

const REBUILT: FanoutCopyRow[] = [{
  ...INITIAL[0],
  recipient_device_id: 'device-new-12345678',
  encrypted_body: 'aegis1.init.v1.payload',
}];

function args(rebuildCopies = vi.fn(async () => REBUILT)) {
  return {
    messageId: INITIAL[0].message_id,
    conversationId: '44444444-4444-4444-8444-444444444444',
    body: JSON.stringify({ encryptionMode: 'multi_device', ct: 'device_copies' }),
    imageUrl: null,
    extra: {},
    senderUserId: INITIAL[0].sender_user_id,
    senderDeviceId: INITIAL[0].sender_device_id,
    initialCopies: INITIAL,
    rebuildCopies,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rollback.mockResolvedValue(1);
});

describe('sendMessageWithAegisRetry', () => {
  it('rebuilds a stale route exactly once and commits the same message id', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'E2EE_DEVICE_LIST_STALE' } })
      .mockResolvedValueOnce({ data: INITIAL[0].message_id, error: null });
    const rebuild = vi.fn(async () => REBUILT);

    const result = await sendMessageWithAegisRetry(args(rebuild));

    expect(result.error).toBeNull();
    expect(result.retriedStaleRoute).toBe(true);
    expect(result.copies).toEqual(REBUILT);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateRoute).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledWith(INITIAL[0].message_id);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1].p_message_id).toBe(INITIAL[0].message_id);
    expect(mocks.rpc.mock.calls[1][1].p_message_id).toBe(INITIAL[0].message_id);
  });

  it('stops after the single stale-route retry', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'E2EE_DEVICE_LIST_STALE' } });
    const rebuild = vi.fn(async () => REBUILT);

    const result = await sendMessageWithAegisRetry(args(rebuild));

    expect(result.error?.message).toContain('E2EE_DEVICE_LIST_STALE');
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateRoute).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).toHaveBeenCalledTimes(2);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('rolls back once on an explicit non-stale rejection', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', message: 'E2EE_INVALID_DEVICE_COPY' },
    });

    const result = await sendMessageWithAegisRetry(args());

    expect(result.error?.message).toBe('E2EE_INVALID_DEVICE_COPY');
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateRoute).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('confirms an ambiguous transport failure idempotently without blind rollback', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: INITIAL[0].message_id, error: null });

    const result = await sendMessageWithAegisRetry(args());

    expect(result.error).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it('leaves state pending when both ambiguous confirmations fail', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'network connection timeout' } });

    const result = await sendMessageWithAegisRetry(args());

    expect(result.error?.message).toContain('timeout');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('rolls back when same-UUID confirmation resolves ambiguity with an explicit rejection', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '23514', message: 'E2EE_INVALID_DEVICE_COPY' },
      });

    const result = await sendMessageWithAegisRetry(args());

    expect(result.error?.message).toBe('E2EE_INVALID_DEVICE_COPY');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('refreshes once when a participant route becomes available during send', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: '23514', message: 'E2EE_PARTICIPANT_ROUTE_UNAVAILABLE' },
      })
      .mockResolvedValueOnce({ data: INITIAL[0].message_id, error: null });
    const rebuild = vi.fn(async () => REBUILT);

    const result = await sendMessageWithAegisRetry(args(rebuild));

    expect(result.error).toBeNull();
    expect(result.retriedStaleRoute).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateRoute).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledWith(INITIAL[0].message_id);
  });

  it('keeps ratchet state pending when the transport promise throws', async () => {
    mocks.rpc.mockRejectedValue(new Error('Failed to fetch'));

    const result = await sendMessageWithAegisRetry(args());

    expect(result.error?.message).toContain('Failed to fetch');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('bounds a transport that never settles and keeps the same ciphertext pending', async () => {
    vi.useFakeTimers();
    try {
      mocks.rpc.mockImplementation(() => new Promise(() => {}));

      const pending = sendMessageWithAegisRetry(args());
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;

      expect(result.error?.message).toContain('NETWORK_TRANSPORT_TIMEOUT');
      expect(mocks.rpc).toHaveBeenCalledTimes(2);
      expect(mocks.rollback).not.toHaveBeenCalled();
      expect(mocks.commit).not.toHaveBeenCalled();
      expect(result.copies).toEqual(INITIAL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a server that does not expose the Aegis device-bound RPC', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42883', message: 'p_sender_device_id overload does not exist' },
    });

    const result = await sendMessageWithAegisRetry(args());

    expect(result.error?.code).toBe('42883');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0][1]).toHaveProperty('p_sender_device_id');
  });
});
