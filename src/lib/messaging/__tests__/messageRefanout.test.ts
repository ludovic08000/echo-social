import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  auth: {
    getSession: vi.fn(async () => ({ data: { session: null } })),
    getUser: vi.fn(async () => ({ data: { user: { id: 'user-new-device' } } })),
  },
  retryStatus: null as null | { status: string; last_error: string | null },
  failedMarks: [] as Array<{ requestId: string; error: string }>,
  loadVolatilePlaintext: vi.fn(),
  loadVolatilePlaintextForCiphertext: vi.fn(),
  encryptPlaintextForDeviceTarget: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    auth: mocks.auth,
  },
}));

vi.mock('../currentDevice', () => ({
  getCurrentDeviceId: () => 'device-new',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/crypto/plaintextStore', () => ({
  loadVolatilePlaintext: mocks.loadVolatilePlaintext,
  loadVolatilePlaintextForCiphertext: mocks.loadVolatilePlaintextForCiphertext,
}));

vi.mock('../multiDeviceFanout', () => ({
  encryptPlaintextForDeviceTarget: mocks.encryptPlaintextForDeviceTarget,
}));

import {
  getMessageRefanoutStatus,
  requestMessageRefanout,
} from '../deviceCopyRetryRequest';
import { processDeviceCopyRetryRequests } from '../deviceCopyRetryProcessor';

function makeBuilder() {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: mocks.retryStatus, error: null })),
  };
  return builder;
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.failedMarks = [];
  mocks.retryStatus = null;
  mocks.loadVolatilePlaintext.mockReset();
  mocks.loadVolatilePlaintextForCiphertext.mockReset();
  mocks.encryptPlaintextForDeviceTarget.mockReset();
  mocks.from.mockImplementation(() => makeBuilder());
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, string>) => {
    if (name === 'request_message_refanout') return { data: 'request-1', error: null };
    if (name === 'list_pending_device_copy_retries') {
      return {
        data: [{
          request_id: 'retry-1',
          message_id: 'message-old',
          conversation_id: 'conv-1',
          message_body: 'x3dh4.session.dh.0.0.iv.ct',
          requester_user_id: 'user-new-device',
          requester_device_id: 'device-new',
          requester_device_public_key: 'pub',
          attempt_count: 0,
        }],
        error: null,
      };
    }
    if (name === 'mark_device_copy_retry_failed') {
      mocks.failedMarks.push({ requestId: args.p_request_id, error: args.p_error });
      return { data: true, error: null };
    }
    return { data: null, error: null };
  });
});

describe('message re-fanout recovery requests', () => {
  it('requests message re-fanout for an old message without a decryptable local key', async () => {
    await expect(
      requestMessageRefanout({ messageId: 'message-refanout-1', senderUserId: 'sender-1' }),
    ).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenCalledWith('request_message_refanout', {
      p_message_id: 'message-refanout-1',
      p_sender_user_id: 'sender-1',
      p_requester_device_id: 'device-new',
    });
  });

  it('falls back to the legacy RPC name only when request_message_refanout is not deployed', async () => {
    mocks.rpc.mockImplementationOnce(async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'function request_message_refanout not found' },
    })).mockImplementationOnce(async () => ({ data: 'legacy-request', error: null }));

    await expect(
      requestMessageRefanout({ messageId: 'message-refanout-2', senderUserId: 'sender-1' }),
    ).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'request_message_refanout', expect.any(Object));
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'request_device_copy_retry', expect.any(Object));
  });

  it('reports terminal impossible re-fanout as a clean UI-safe status', async () => {
    mocks.retryStatus = {
      status: 'failed',
      last_error: 'PLAINTEXT_UNAVAILABLE: sender device has no local plaintext cache',
    };

    await expect(
      getMessageRefanoutStatus({ messageId: 'message-old', senderUserId: 'sender-1' }),
    ).resolves.toEqual({
      terminal: true,
      status: 'failed',
      errorCode: 'REFANOUT_UNAVAILABLE',
    });
  });

  it('does not use persistent plaintext for re-fanout processing', async () => {
    mocks.loadVolatilePlaintext.mockResolvedValue(null);
    mocks.loadVolatilePlaintextForCiphertext.mockResolvedValue(null);

    const result = await processDeviceCopyRetryRequests();

    expect(result.failed).toBe(1);
    expect(mocks.encryptPlaintextForDeviceTarget).not.toHaveBeenCalled();
    expect(mocks.failedMarks[0].error).toMatch(/^PLAINTEXT_UNAVAILABLE:/);
  });
});
