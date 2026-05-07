/**
 * Lot L6 — Key Transparency: Merkle helpers (RFC 6962-style).
 *
 * Domain separation:
 *   leafHash(data)      = SHA256(0x00 || data)
 *   nodeHash(left,right)= SHA256(0x01 || left || right)
 *
 * Used by:
 *   - the `kt-publish-epoch` Edge Function (server-side aggregation)
 *   - the auditor UI to verify inclusion proofs
 *
 * Pure functions, no IO. Browser-safe (Web Crypto).
 */

const enc = (s: string) => new TextEncoder().encode(s);

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('KT_INVALID_HEX');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view so subtle.digest accepts it
  // under strict TS lib.dom typings (Uint8Array<ArrayBufferLike> mismatch).
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const hash = await crypto.subtle.digest('SHA-256', buf.buffer);
  return new Uint8Array(hash);
}

/**
 * Canonical leaf payload string for a transparency log entry.
 * The exact stringification MUST match between server (publisher) and
 * any auditor verifying inclusion. Keep keys sorted alphabetically.
 */
export function canonicalLeafPayload(entry: {
  id: number | string;
  user_id: string;
  event_type: string;
  fingerprint?: string | null;
  identity_epoch?: number | null;
  device_id?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}): string {
  const sorted: Record<string, unknown> = {
    created_at: entry.created_at,
    device_id: entry.device_id ?? null,
    event_type: entry.event_type,
    fingerprint: entry.fingerprint ?? null,
    id: String(entry.id),
    identity_epoch: entry.identity_epoch ?? null,
    payload: entry.payload ?? {},
    user_id: entry.user_id,
  };
  return JSON.stringify(sorted);
}

export async function leafHash(payload: string): Promise<string> {
  const bytes = concatBytes(new Uint8Array([0x00]), enc(payload));
  return bytesToHex(await sha256(bytes));
}

export async function nodeHash(leftHex: string, rightHex: string): Promise<string> {
  const bytes = concatBytes(new Uint8Array([0x01]), hexToBytes(leftHex), hexToBytes(rightHex));
  return bytesToHex(await sha256(bytes));
}

/**
 * Build a Merkle tree from an ordered list of leaf hashes (hex).
 * Returns the root hash and the per-level arrays (level 0 = leaves).
 *
 * RFC 6962 convention: when a level has an odd count, the lone right node
 * is duplicated implicitly (its parent = nodeHash(node, node)). That keeps
 * proofs stable even for non-power-of-two leaf counts.
 */
export async function buildMerkleTree(
  leafHashes: string[],
): Promise<{ root: string; levels: string[][] }> {
  if (leafHashes.length === 0) {
    // Empty tree → root is SHA256("") for determinism.
    const empty = bytesToHex(await sha256(new Uint8Array()));
    return { root: empty, levels: [[]] };
  }
  const levels: string[][] = [leafHashes.slice()];
  let current = levels[0];
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(await nodeHash(left, right));
    }
    levels.push(next);
    current = next;
  }
  return { root: current[0], levels };
}

export type MerkleProofStep = { sibling: string; position: 'left' | 'right' };

/** Inclusion proof for the leaf at `index`. Walk bottom-up. */
export function buildInclusionProof(levels: string[][], index: number): MerkleProofStep[] {
  if (levels.length === 0 || levels[0].length === 0) return [];
  const proof: MerkleProofStep[] = [];
  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = siblingIdx < nodes.length ? nodes[siblingIdx] : nodes[idx]; // duplicate
    proof.push({ sibling, position: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Re-derive the root from a leaf + proof and compare. */
export async function verifyInclusionProof(
  leaf: string,
  proof: MerkleProofStep[],
  expectedRoot: string,
): Promise<boolean> {
  let acc = leaf;
  for (const step of proof) {
    acc = step.position === 'left'
      ? await nodeHash(step.sibling, acc)
      : await nodeHash(acc, step.sibling);
  }
  return acc === expectedRoot;
}

/**
 * Canonical bytes signed by the server for an epoch head.
 * Auditors verify Ed25519(server_pub, signedHeadBytes(...)) == signature.
 */
export function signedHeadBytes(epoch: number | bigint, root: string, leafCount: number | bigint, prevEpoch: number | bigint | null): Uint8Array {
  const obj = {
    epoch: String(epoch),
    leaf_count: String(leafCount),
    prev_epoch: prevEpoch === null ? null : String(prevEpoch),
    root,
  };
  return enc(JSON.stringify(obj));
}
