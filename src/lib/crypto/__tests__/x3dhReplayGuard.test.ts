/**
 * X3DH Anti-Replay Guard tests (Lot 1.1)
 *
 * Verifies Signal X3DH §4.6: an X3DH initial message tuple
 * (IKa, EKa, spkId, opkId) cannot be processed twice — even if the
 * one-time-prekey deletion silently fails.
 *
 * Each test uses a unique (myUserId, ek) pair so that a single shared
 * IndexedDB stays consistent (deleteDatabase under fake-indexeddb can block
 * indefinitely while a connection is still cached by hardGlobals).
 */
import { describe, it, expect } from 'vitest';
import { assertNotReplayedAndRecord } from '../x3dhReplayGuard';

let testCounter = 0;
function uniqueParams(overrides: Partial<Parameters<typeof assertNotReplayedAndRecord>[0]> = {}) {
  testCounter++;
  return {
    myUserId: `00000000-0000-4000-8000-${testCounter.toString().padStart(12, '0')}`,
    ik: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ek: `EEEE${testCounter.toString().padStart(40, '0')}=`,
    spkId: 1,
    opkId: 42 as number | undefined,
    ...overrides,
  };
}

describe('x3dhReplayGuard', () => {
  it('records first occurrence and rejects identical replay', async () => {
    const p = uniqueParams();
    await expect(assertNotReplayedAndRecord(p)).resolves.toBeUndefined();
    await expect(assertNotReplayedAndRecord(p)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('treats different opkId as a distinct initial message', async () => {
    const p = uniqueParams();
    await assertNotReplayedAndRecord(p);
    await expect(
      assertNotReplayedAndRecord({ ...p, opkId: (p.opkId ?? 0) + 1 }),
    ).resolves.toBeUndefined();
  });

  it('treats different ephemeral key as a distinct initial message', async () => {
    const p = uniqueParams();
    await assertNotReplayedAndRecord(p);
    await expect(
      assertNotReplayedAndRecord({ ...p, ek: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA=' }),
    ).resolves.toBeUndefined();
  });

  it('treats different responder (myUserId) as a distinct entry', async () => {
    const p = uniqueParams();
    await assertNotReplayedAndRecord(p);
    await expect(
      assertNotReplayedAndRecord({ ...p, myUserId: '00000000-0000-4000-8000-ffffffffffff' }),
    ).resolves.toBeUndefined();
  });

  it('handles 3-DH variant (no opkId) symmetrically', async () => {
    const p = uniqueParams({ opkId: undefined });
    await expect(assertNotReplayedAndRecord(p)).resolves.toBeUndefined();
    await expect(assertNotReplayedAndRecord(p)).rejects.toThrow('X3DH_REPLAY_DETECTED');
  });

  it('treats different spkId as a distinct initial message', async () => {
    const p = uniqueParams();
    await assertNotReplayedAndRecord(p);
    await expect(
      assertNotReplayedAndRecord({ ...p, spkId: p.spkId + 1 }),
    ).resolves.toBeUndefined();
  });
});
