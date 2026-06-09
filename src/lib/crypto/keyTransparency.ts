import { supabase } from '@/integrations/supabase/client';

export interface KeyTransparencyTreeHead {
  epoch: number;
  leafCount: number;
  rootHash: string;
  prevEpoch: number | null;
  signingKeyId: string;
  signatureHex: string;
  createdAt: string;
}

export interface KeyTransparencySigningKey {
  id: string;
  publicKeyJwk: JsonWebKey;
  algorithm: string;
}

export interface KeyTransparencyVerifiedHead extends KeyTransparencyTreeHead {
  signatureOk: boolean;
  chainOk: boolean;
  error?: string;
}

const enc = (value: string) => new TextEncoder().encode(value);

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('KT_BAD_HEX');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function signedTreeHeadBytes(head: Pick<KeyTransparencyTreeHead, 'epoch' | 'rootHash' | 'leafCount' | 'prevEpoch'>): Uint8Array {
  return enc(JSON.stringify({
    epoch: String(head.epoch),
    leaf_count: String(head.leafCount),
    prev_epoch: head.prevEpoch === null ? null : String(head.prevEpoch),
    root: head.rootHash,
  }));
}

export async function verifyTreeHeadSignature(
  head: KeyTransparencyTreeHead,
  signingKey: KeyTransparencySigningKey | undefined,
): Promise<boolean> {
  if (!signingKey || signingKey.algorithm !== 'Ed25519') return false;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    signingKey.publicKeyJwk,
    { name: 'Ed25519' } as any,
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' } as any,
    publicKey,
    hexToBytes(head.signatureHex),
    signedTreeHeadBytes(head),
  );
}

export async function verifyTreeHeadChain(
  heads: KeyTransparencyTreeHead[],
  signingKeys: KeyTransparencySigningKey[],
): Promise<KeyTransparencyVerifiedHead[]> {
  const keyById = new Map(signingKeys.map(key => [key.id, key]));
  const ascending = heads.slice().sort((a, b) => a.epoch - b.epoch);
  const results = new Map<number, KeyTransparencyVerifiedHead>();

  for (let i = 0; i < ascending.length; i++) {
    const head = ascending[i];
    const previous = i > 0 ? ascending[i - 1] : null;
    let signatureOk = false;
    let error: string | undefined;

    try {
      signatureOk = await verifyTreeHeadSignature(head, keyById.get(head.signingKeyId));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const chainOk =
      previous === null
        ? head.prevEpoch === null || head.prevEpoch < head.epoch
        : head.prevEpoch === previous.epoch;

    results.set(head.epoch, {
      ...head,
      signatureOk,
      chainOk,
      error,
    });
  }

  return heads.map(head => results.get(head.epoch) ?? {
    ...head,
    signatureOk: false,
    chainOk: false,
    error: 'KT_VERIFY_MISSING_RESULT',
  });
}

export async function fetchVerifiedTreeHeads(limit = 20): Promise<KeyTransparencyVerifiedHead[]> {
  const { data: headRows, error: headError } = await (supabase as any)
    .from('e2ee_kt_tree_heads')
    .select('epoch, leaf_count, root_hash, prev_epoch, signing_key_id, signature, created_at')
    .order('epoch', { ascending: false })
    .limit(limit);
  if (headError) throw headError;

  const heads: KeyTransparencyTreeHead[] = ((headRows || []) as any[]).map(row => ({
    epoch: Number(row.epoch),
    leafCount: Number(row.leaf_count),
    rootHash: String(row.root_hash),
    prevEpoch: row.prev_epoch === null || row.prev_epoch === undefined ? null : Number(row.prev_epoch),
    signingKeyId: String(row.signing_key_id),
    signatureHex: String(row.signature),
    createdAt: String(row.created_at),
  }));

  const keyIds = [...new Set(heads.map(head => head.signingKeyId))];
  if (keyIds.length === 0) return [];

  const { data: keyRows, error: keyError } = await (supabase as any)
    .from('e2ee_kt_signing_keys')
    .select('id, public_key_jwk, algorithm')
    .in('id', keyIds);
  if (keyError) throw keyError;

  const keys: KeyTransparencySigningKey[] = ((keyRows || []) as any[]).map(row => ({
    id: String(row.id),
    publicKeyJwk: row.public_key_jwk as JsonWebKey,
    algorithm: String(row.algorithm),
  }));

  return verifyTreeHeadChain(heads, keys);
}
