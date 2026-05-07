import { describe, it, expect } from 'vitest';
import {
  canonicalLeafPayload,
  leafHash,
  buildMerkleTree,
  buildInclusionProof,
  verifyInclusionProof,
  signedHeadBytes,
} from '../ktMerkle';

async function makeLeaves(n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      await leafHash(
        canonicalLeafPayload({
          id: i + 1,
          user_id: 'u',
          event_type: 'identity_bootstrap',
          fingerprint: `fp_${i}`,
          identity_epoch: 1,
          device_id: `d_${i}`,
          payload: { i },
          created_at: '2026-01-01T00:00:00Z',
        }),
      ),
    );
  }
  return out;
}

describe('Lot L6 — KT Merkle helpers', () => {
  it('canonical payload sorts keys deterministically', async () => {
    const a = canonicalLeafPayload({
      id: 1, user_id: 'u', event_type: 'x', created_at: 't', payload: { b: 2, a: 1 },
    });
    expect(a.indexOf('"created_at"')).toBeLessThan(a.indexOf('"event_type"'));
    expect(a.indexOf('"event_type"')).toBeLessThan(a.indexOf('"user_id"'));
  });

  it('leafHash is stable and 64 hex chars', async () => {
    const h1 = await leafHash('hello');
    const h2 = await leafHash('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const h3 = await leafHash('hellp');
    expect(h3).not.toBe(h1);
  });

  it('builds a tree and proves inclusion for power-of-two count (n=4)', async () => {
    const leaves = await makeLeaves(4);
    const { root, levels } = await buildMerkleTree(leaves);
    expect(levels.length).toBe(3); // 4 → 2 → 1
    for (let i = 0; i < 4; i++) {
      const proof = buildInclusionProof(levels, i);
      const ok = await verifyInclusionProof(leaves[i], proof, root);
      expect(ok).toBe(true);
    }
  });

  it('builds a tree and proves inclusion for odd count (n=5, duplicate-right)', async () => {
    const leaves = await makeLeaves(5);
    const { root, levels } = await buildMerkleTree(leaves);
    for (let i = 0; i < 5; i++) {
      const proof = buildInclusionProof(levels, i);
      const ok = await verifyInclusionProof(leaves[i], proof, root);
      expect(ok).toBe(true);
    }
  });

  it('rejects a tampered leaf', async () => {
    const leaves = await makeLeaves(3);
    const { root, levels } = await buildMerkleTree(leaves);
    const proof = buildInclusionProof(levels, 1);
    const tampered = await leafHash('definitely-not-the-original');
    const ok = await verifyInclusionProof(tampered, proof, root);
    expect(ok).toBe(false);
  });

  it('rejects a swapped sibling position', async () => {
    const leaves = await makeLeaves(4);
    const { root, levels } = await buildMerkleTree(leaves);
    const proof = buildInclusionProof(levels, 2);
    const flipped = proof.map((s) => ({ ...s, position: s.position === 'left' ? 'right' : 'left' as const }));
    const ok = await verifyInclusionProof(leaves[2], flipped as any, root);
    expect(ok).toBe(false);
  });

  it('signedHeadBytes is canonical', () => {
    const a = signedHeadBytes(7n, 'abc', 4, 6n);
    const b = signedHeadBytes(7n, 'abc', 4, 6n);
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b));
    expect(new TextDecoder().decode(a)).toContain('"epoch":"7"');
    expect(new TextDecoder().decode(a)).toContain('"prev_epoch":"6"');
  });
});
