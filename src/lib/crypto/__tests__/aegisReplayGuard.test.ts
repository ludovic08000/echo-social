import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import {
  cancelAegisInitial,
  finalizeAegisInitial,
  reserveAegisInitial,
} from '../aegisReplayGuard';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
let counter = 0;

function fresh() {
  counter += 1;
  return {
    myUserId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    ik: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ek: `AEGIS${counter.toString().padStart(39, '0')}=`,
    spkId: 1,
    opkId: 7,
  };
}

beforeEach(() => {
  rpc.mockReset();
});

describe('Aegis authoritative replay ledger', () => {
  it('rejects a tuple already finalized by the server', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, state: 'replay' }, error: null });
    await expect(reserveAegisInitial(fresh())).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('reserves and finalizes through the two-phase server contract', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { ok: true, state: 'reserved', reservation_token: '11111111-1111-4111-8111-111111111111' },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });

    const reservation = await reserveAegisInitial(fresh());
    expect(reservation.serverToken).toBe('11111111-1111-4111-8111-111111111111');
    await expect(finalizeAegisInitial(reservation)).resolves.toBeUndefined();
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      'reserve_x3dh_initial',
      'finalize_x3dh_initial',
    ]);
  });

  it('cancels a failed authentication on server and device', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { ok: true, state: 'reserved', reservation_token: '22222222-2222-4222-8222-222222222222' },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });

    const reservation = await reserveAegisInitial(fresh());
    await expect(cancelAegisInitial(reservation)).resolves.toBeUndefined();
    expect(rpc.mock.calls[1][0]).toBe('cancel_x3dh_initial');
  });

  it('fails closed when the authoritative ledger is unavailable', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });
    await expect(reserveAegisInitial(fresh())).rejects.toThrow('AEGIS_REPLAY_LEDGER_UNAVAILABLE');
  });

  it('binds the replay fingerprint to the receiving device identity', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { ok: true, reservation_token: '33333333-3333-4333-8333-333333333333' },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({
        data: { ok: true, reservation_token: '44444444-4444-4444-8444-444444444444' },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });

    const first = fresh();
    const a = await reserveAegisInitial(first);
    await cancelAegisInitial(a);
    const b = await reserveAegisInitial({ ...first, myUserId: '00000000-0000-4000-8000-999999999999' });
    await cancelAegisInitial(b);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
