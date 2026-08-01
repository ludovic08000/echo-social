import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getSession: mocks.getSession },
    rpc: mocks.rpc,
  },
}));

import {
  callAegisServer,
  getAegisTransportKind,
} from '@/lib/messaging/aegisTransport';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Aegis transport boundary', () => {
  it('uses direct Supabase RPC when no VPS gateway is configured', async () => {
    mocks.rpc.mockResolvedValue({ data: 3, error: null });

    await expect(callAegisServer<number>('aegis_send_message', {
      p_device_id: 'device-one',
      p_message_ids: ['message-one'],
    })).resolves.toEqual({ data: 3, error: null });

    expect(getAegisTransportKind()).toBe('supabase');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('uses the HTTPS VPS gateway with the current Supabase bearer token', async () => {
    vi.stubEnv('VITE_AEGIS_SERVER_URL', 'https://aegis.example.test/');
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt-one' } },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: 1, error: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callAegisServer<number>('aegis_send_message', {
      p_device_id: 'device-one',
      p_message_ids: ['message-one'],
    })).resolves.toEqual({ data: 1, error: null });

    expect(getAegisTransportKind()).toBe('gateway');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://aegis.example.test/v1/rpc/aegis_send_message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer jwt-one',
        }),
      }),
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects cleartext remote gateway configuration', () => {
    vi.stubEnv('VITE_AEGIS_SERVER_URL', 'http://aegis.example.test');
    expect(() => getAegisTransportKind()).toThrow('AEGIS_SERVER_HTTPS_REQUIRED');
  });
});
