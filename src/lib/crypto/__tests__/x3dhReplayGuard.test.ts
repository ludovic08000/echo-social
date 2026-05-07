/**
 * X3DH Anti-Replay Guard tests (Lot 1.1)
 *
 * Verifies Signal X3DH §4.6: an X3DH initial message tuple
 * (IKa, EKa, spkId, opkId) cannot be processed twice — even if the
 * one-time-prekey deletion silently fails.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { assertNotReplayedAndRecord } from '../x3dhReplayGuard';

const baseParams = {
  myUserId: '00000000-0000-4000-8000-000000000001',
  ik: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ek: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
  spkId: 1,
  opkId: 42,
};

describe('x3dhReplayGuard', () => {
  beforeEach(async () => {
    // Fresh DB for each test (fake-indexeddb supports deleteDatabase)
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('forsure-x3dh-replay');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('records first occurrence and rejects identical replay', async () => {
    await expect(assertNotReplayedAndRecord(baseParams)).resolves.toBeUndefined();
    await expect(assertNotReplayedAndRecord(baseParams)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('treats different opkId as a distinct initial message', async () => {
    await assertNotReplayedAndRecord(baseParams);
    await expect(
      assertNotReplayedAndRecord({ ...baseParams, opkId: 43 }),
    ).resolves.toBeUndefined();
  });

  it('treats different ephemeral key as a distinct initial message', async () => {
    await assertNotReplayedAndRecord(baseParams);
    await expect(
      assertNotReplayedAndRecord({ ...baseParams, ek: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA=' }),
    ).resolves.toBeUndefined();
  });

  it('treats different responder (myUserId) as a distinct entry', async () => {
    await assertNotReplayedAndRecord(baseParams);
    await expect(
      assertNotReplayedAndRecord({ ...baseParams, myUserId: '00000000-0000-4000-8000-000000000002' }),
    ).resolves.toBeUndefined();
  });

  it('handles 3-DH variant (no opkId) symmetrically', async () => {
    const noOpk = { ...baseParams, opkId: undefined as number | undefined };
    await expect(assertNotReplayedAndRecord(noOpk)).resolves.toBeUndefined();
    await expect(assertNotReplayedAndRecord(noOpk)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });
});
