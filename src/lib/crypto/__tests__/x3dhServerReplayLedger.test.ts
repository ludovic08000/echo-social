/**
 * L3 — Server-side X3DH replay ledger integration test
 *
 * Verifies that when the server `claim_x3dh_initial` RPC reports a replay
 * (returns `false`), the client guard refuses the message even if the local
 * IDB has never seen it. This protects against device wipes / private mode
 * bypassing the client-only cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock store — must be defined inside vi.mock factory to avoid TDZ
vi.mock('@/integrations/supabase/client', () => {
  return {
    supabase: {
      rpc: vi.fn(),
    },
  };
});

import { supabase } from '@/integrations/supabase/client';
import {
  assertNotReplayedAndRecord,
  __resetReplayLedgerServerBackoffForTests,
} from '../x3dhReplayGuard';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

let n = 0;
function fresh() {
  n++;
  return {
    myUserId: `00000000-0000-4000-8000-${`srv${n}`.padStart(12, '0')}`,
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

describe('L3 — server replay ledger', () => {
  it('rejects when the server reports a duplicate (claimed=false)', async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(assertNotReplayedAndRecord(fresh())).rejects.toThrow('X3DH_REPLAY_DETECTED');
    expect(rpc).toHaveBeenCalledWith('claim_x3dh_initial', expect.objectContaining({
      p_fingerprint: expect.any(String),
    }));
  });

  it('passes through when the server confirms first claim (claimed=true)', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(assertNotReplayedAndRecord(fresh())).resolves.toBeUndefined();
  });

  it('falls back to local IDB guard when the RPC errors (network down)', async () => {
    // RPC returns an error → must not throw, local IDB takes over
    rpc.mockResolvedValue({ data: null, error: { message: 'network down' } });
    const p = fresh();
    await expect(assertNotReplayedAndRecord(p)).resolves.toBeUndefined();
    // Same message replayed — local IDB must now reject
    await expect(assertNotReplayedAndRecord(p)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('sends a stable fingerprint (same input → same hash)', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const p = fresh();
    await assertNotReplayedAndRecord(p);
    const fp1 = rpc.mock.calls[0][1].p_fingerprint;
    rpc.mockClear();
    rpc.mockResolvedValue({ data: true, error: null });
    // Different myUserId but same IK/EK/spkId/opkId → MUST produce a different fp
    await assertNotReplayedAndRecord({ ...p, myUserId: '00000000-0000-4000-8000-zzzzzzzzzzzz' });
    const fp2 = rpc.mock.calls[0][1].p_fingerprint;
    expect(fp1).not.toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('backs off the server ledger after an RPC error to avoid repeated 400s', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'bad request' } });
    await expect(assertNotReplayedAndRecord(fresh())).resolves.toBeUndefined();
    await expect(assertNotReplayedAndRecord(fresh())).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
