import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMerkleTree, leafHash, signedHeadBytes } from '../ktMerkle';

const { rpc } = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc },
}));

import { verifyLatestTransparencyEpoch } from '../transparencyLog';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signedHeadFixture() {
  const leaves = [
    await leafHash('leaf-a'),
    await leafHash('leaf-b'),
    await leafHash('leaf-c'),
  ];
  const { root } = await buildMerkleTree(leaves);
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' } as any,
    pair.privateKey,
    signedHeadBytes(12n, root, BigInt(leaves.length), 11n),
  );
  return {
    leaves,
    head: {
      epoch: 12,
      root,
      leaf_count: leaves.length,
      prev_epoch: 11,
      signing_key_id: '00000000-0000-0000-0000-000000000001',
      signature: bytesToHex(new Uint8Array(signature)),
      public_key_jwk: publicKeyJwk,
      created_at: '2026-07-05T00:00:00Z',
    },
  };
}

describe('transparencyLog key transparency verifier', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('verifies a signed KT head and Merkle root', async () => {
    const fixture = await signedHeadFixture();
    rpc.mockImplementation((name: string) => {
      if (name === 'kt_latest_head') return Promise.resolve({ data: fixture.head, error: null });
      if (name === 'kt_get_epoch_leaves') {
        return Promise.resolve({
          data: fixture.leaves.map((leaf_hash, leaf_index) => ({ leaf_index, leaf_hash })),
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: new Error(`unexpected rpc ${name}`) });
    });

    const result = await verifyLatestTransparencyEpoch();
    expect(result.ok).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.rootMatches).toBe(true);
  });

  it('rejects a valid signature if epoch leaves do not match the head root', async () => {
    const fixture = await signedHeadFixture();
    rpc.mockImplementation((name: string) => {
      if (name === 'kt_latest_head') return Promise.resolve({ data: fixture.head, error: null });
      if (name === 'kt_get_epoch_leaves') {
        const tampered = fixture.leaves.slice();
        tampered[1] = '0'.repeat(64);
        return Promise.resolve({
          data: tampered.map((leaf_hash, leaf_index) => ({ leaf_index, leaf_hash })),
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: new Error(`unexpected rpc ${name}`) });
    });

    const result = await verifyLatestTransparencyEpoch();
    expect(result.ok).toBe(false);
    expect(result.signatureValid).toBe(true);
    expect(result.rootMatches).toBe(false);
  });
});
