import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: { ok: true, code: 'RETRY_REQUEST_QUEUED' }, error: null }),
  },
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('../currentDevice', () => ({
  getCurrentDeviceId: () => 'device-current',
  isDeviceIdTemporary: () => false,
}));

import { supabase } from '@/integrations/supabase/client';
import { logCryptoError } from '@/lib/crypto/errorLogger';
import { requestDeviceCopyRetry } from '../deviceCopyRetryRequest';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const log = logCryptoError as unknown as ReturnType<typeof vi.fn>;

describe('requestDeviceCopyRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('deduplicates repeated requests for the same message/device', async () => {
    await expect(requestDeviceCopyRetry({ messageId: 'm1', senderUserId: 'sender' })).resolves.toBe(true);
    await expect(requestDeviceCopyRetry({ messageId: 'm1', senderUserId: 'sender' })).resolves.toBe(false);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('suppresses success log spam across a burst from the same sender/device', async () => {
    for (let i = 0; i < 6; i++) {
      await requestDeviceCopyRetry({ messageId: `burst-${i}`, senderUserId: 'sender-burst' });
    }

    expect(rpc).toHaveBeenCalledTimes(6);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      errorCode: 'DEVICE_COPY_RETRY_REQUESTED',
      myDeviceId: 'device-current',
    });
  });

  it('treats RPC json ok=false responses as failures', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, code: 'NOT_CONVERSATION_PARTICIPANT' }, error: null });

    await expect(requestDeviceCopyRetry({ messageId: 'm-denied', senderUserId: 'sender-denied' })).resolves.toBe(false);

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warning',
      errorCode: 'DEVICE_COPY_RETRY_REQUEST_FAILED',
      errorMessage: 'NOT_CONVERSATION_PARTICIPANT',
    }));
  });
});
