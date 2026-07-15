/**
 * Server/local X3DH replay reservation tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import {
  assertNotReplayedAndRecord,
  cancelX3dhInitial,
  finalizeX3dhInitial,
  reserveX3dhInitial,
  __resetReplayLedgerServerBackoffForTests,
} from '../x3dhReplayGuard';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

let n = 0;
function fresh() {
  n += 1;
  return {
    myUserId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    ik: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ek: `SRVR${n.toString().padStart(40, '0')}=`,
    spkId: 1,
    opkId: 7,
  };
}

beforeEach(() => {
  rpc.mockReset();
  __resetReplayLedgerServerBackoffForTests();
});

describe('X3DH two-phase replay ledger', () => {
  it('rejects a tuple already finalized by the authoritative server', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, state: 'replay' }, error: null });
    await expect(reserveX3dhInitial(fresh())).rejects.toThrow('X3DH_REPLAY_DETECTED');
    expect(rpc).toHaveBeenCalledWith('reserve_x3dh_initial', expect.objectContaining({
      p_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('reserves then finalizes only after the caller confirms authentication', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { ok: true, state: 'reserved', reservation_token: '11111111-1111-4111-8111-111111111111' },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });

    const params = fresh();
    const reservation = await reserveX3dhInitial(params);
    expect(reservation.serverMode).toBe('two_phase');
    await expect(finalizeX3dhInitial(reservation)).resolves.toBeUndefined();
    await expect(reserveX3dhInitial(params)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('cancels a failed authentication and permits a legitimate retransmission', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { ok: true, state: 'reserved', reservation_token: '22222222-2222-4222-8222-222222222222' },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({
        data: { ok: true, state: 'reserved', reservation_token: '33333333-3333-4333-8333-333333333333' },
        error: null,
      });

    const params = fresh();
    const first = await reserveX3dhInitial(params);
    await cancelX3dhInitial(first);
    await expect(reserveX3dhInitial(params)).resolves.toMatchObject({ serverMode: 'two_phase' });
  });

  it('claims the legacy server ledger during finalize, never during reserve', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'reserve_x3dh_initial does not exist' } })
      .mockResolvedValueOnce({ data: true, error: null });

    const reservation = await reserveX3dhInitial(fresh());
    expect(reservation.serverMode).toBe('legacy_finalize');
    expect(rpc).toHaveBeenCalledTimes(1);
    await finalizeX3dhInitial(reservation);
    expect(rpc.mock.calls[1][0]).toBe('claim_x3dh_initial');
  });

  it('keeps a local finalized guard when the server is temporarily unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'network down' } });
    const params = fresh();
    await expect(assertNotReplayedAndRecord(params)).resolves.toBeUndefined();
    await expect(assertNotReplayedAndRecord(params)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('uses a stable user-bound fingerprint', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'reserve_x3dh_initial does not exist' } });
    const first = fresh();
    const reservation = await reserveX3dhInitial(first);
    expect(reservation.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await cancelX3dhInitial(reservation);

    const otherUser = await reserveX3dhInitial({ ...first, myUserId: '00000000-0000-4000-8000-999999999999' });
    expect(otherUser.fingerprint).not.toBe(reservation.fingerprint);
    await cancelX3dhInitial(otherUser);
  });
});