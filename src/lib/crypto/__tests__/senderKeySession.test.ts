/**
 * L2 — Sender Keys group integration test
 *
 * Verifies the orchestrator end-to-end with NO database (persist:false):
 *   1. Owner generates a session
 *   2. SKDM is built and "delivered" (parseSKDM round-trip) to two recipients
 *   3. Owner sends 3 messages → both recipients decrypt in order
 *   4. Out-of-order delivery (msg #3 before #2) still succeeds via fast-forward
 *   5. Replay of an old iteration is REJECTED (no plaintext leak)
 *   6. Tampered ciphertext is REJECTED by the per-message signature
 *   7. After rotation, the previous chain CANNOT decrypt new messages
 */
import { describe, it, expect } from 'vitest';
import {
  ensureOwnerSession,
  snapshotForDistribution,
  encryptForGroup,
  installSKDM,
  decryptFromGroup,
  rotateOwnerSession,
} from '../senderKeySession';

const CONV = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE_DEV = 'alice-dev-1';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHARLIE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('L2 — Sender Keys group session (Signal Sender Keys)', () => {
  it('round-trip: 3 messages decrypt in order at 2 recipients', async () => {
    let owner = await ensureOwnerSession(CONV, ALICE, ALICE_DEV, { persist: false });
    const skdm = snapshotForDistribution(owner);

    let bob = await installSKDM(skdm, { persist: false });
    let charlie = await installSKDM(skdm, { persist: false });
    expect(bob).not.toBeNull();
    expect(charlie).not.toBeNull();

    const msgs = ['hello', 'group!', '🎉'];
    const wires: string[] = [];
    for (const m of msgs) {
      const r = await encryptForGroup(owner, m, { persist: false });
      wires.push(r.wire);
      owner = r.nextState;
    }

    for (const w of wires) {
      const rb = await decryptFromGroup(bob!, w, { persist: false });
      bob = rb.nextState;
      expect(rb.plaintext).toBe(msgs[wires.indexOf(w)]);

      const rc = await decryptFromGroup(charlie!, w, { persist: false });
      charlie = rc.nextState;
      expect(rc.plaintext).toBe(msgs[wires.indexOf(w)]);
    }
  });

  it('out-of-order delivery: message N+1 arrives before N (fast-forward)', async () => {
    let owner = await ensureOwnerSession(CONV, ALICE, ALICE_DEV, { persist: false });
    const skdm = snapshotForDistribution(owner);
    let bob = await installSKDM(skdm, { persist: false });

    const w0 = await encryptForGroup(owner, 'm0', { persist: false }); owner = w0.nextState;
    const w1 = await encryptForGroup(owner, 'm1', { persist: false }); owner = w1.nextState;
    const w2 = await encryptForGroup(owner, 'm2', { persist: false }); owner = w2.nextState;

    // Bob receives m2 first → fast-forwards from iter=0 to iter=2
    const r2 = await decryptFromGroup(bob!, w2.wire, { persist: false });
    expect(r2.plaintext).toBe('m2');
    bob = r2.nextState;

    // Now m0 / m1 arrive late → MUST be rejected (no historical key cache)
    const r0 = await decryptFromGroup(bob!, w0.wire, { persist: false });
    expect(r0.plaintext).toBeNull();
    const r1 = await decryptFromGroup(bob!, w1.wire, { persist: false });
    expect(r1.plaintext).toBeNull();
  });

  it('replay of the SAME iteration after consumption is rejected', async () => {
    let owner = await ensureOwnerSession(CONV, ALICE, ALICE_DEV, { persist: false });
    let bob = await installSKDM(snapshotForDistribution(owner), { persist: false });

    const m0 = await encryptForGroup(owner, 'one-shot', { persist: false }); owner = m0.nextState;
    const r1 = await decryptFromGroup(bob!, m0.wire, { persist: false });
    expect(r1.plaintext).toBe('one-shot');
    bob = r1.nextState;

    const r2 = await decryptFromGroup(bob!, m0.wire, { persist: false });
    expect(r2.plaintext).toBeNull();
  });

  it('tampered ciphertext is rejected by the per-message signature', async () => {
    let owner = await ensureOwnerSession(CONV, ALICE, ALICE_DEV, { persist: false });
    let bob = await installSKDM(snapshotForDistribution(owner), { persist: false });
    const m = await encryptForGroup(owner, 'authentic', { persist: false });

    // Flip one base64 char in the ciphertext slot (parts[5])
    const parts = m.wire.split('.');
    const orig = parts[6];
    parts[6] = orig.startsWith('A') ? 'B' + orig.slice(1) : 'A' + orig.slice(1);
    const tampered = parts.join('.');

    const r = await decryptFromGroup(bob!, tampered, { persist: false });
    expect(r.plaintext).toBeNull();
  });

  it('rotation: a NEW chain replaces the old one — old chain cannot decrypt new messages', async () => {
    let owner = await ensureOwnerSession(CONV, ALICE, ALICE_DEV, { persist: false });
    const oldBob = await installSKDM(snapshotForDistribution(owner), { persist: false });

    // Rotate (member-leave / device-add scenario)
    owner = await rotateOwnerSession(CONV, ALICE, ALICE_DEV, { persist: false });
    const m = await encryptForGroup(owner, 'after-rotation', { persist: false });

    // Bob still on the old chain → MUST fail
    const stale = await decryptFromGroup(oldBob!, m.wire, { persist: false });
    expect(stale.plaintext).toBeNull();

    // Bob installs the new SKDM → now decrypts
    const freshBob = await installSKDM(snapshotForDistribution(owner), { persist: false });
    const ok = await decryptFromGroup(freshBob!, m.wire, { persist: false });
    expect(ok.plaintext).toBe('after-rotation');
  });
});
