type WorkerRequest =
  | { id: string; type: 'buildMerkleRoot'; leaves: string[] };

type WorkerResponse =
  | { id: string; ok: true; root: string }
  | { id: string; ok: false; error: string };

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('INVALID_HEX');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function nodeHash(leftHex: string, rightHex: string): Promise<string> {
  return bytesToHex(
    await sha256(concatBytes(new Uint8Array([0x01]), hexToBytes(leftHex), hexToBytes(rightHex))),
  );
}

async function buildMerkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return bytesToHex(await sha256(new Uint8Array()));
  let current = leaves.slice();
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(await nodeHash(current[i], i + 1 < current.length ? current[i + 1] : current[i]));
    }
    current = next;
  }
  return current[0];
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'buildMerkleRoot') {
      const root = await buildMerkleRoot(msg.leaves);
      self.postMessage({ id: msg.id, ok: true, root } satisfies WorkerResponse);
      return;
    }
    self.postMessage({ id: msg.id, ok: false, error: 'UNKNOWN_TASK' } satisfies WorkerResponse);
  } catch (error) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};

export {};
