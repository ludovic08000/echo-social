import { buildMerkleTree } from './ktMerkle';

type WorkerResponse =
  | { id: string; ok: true; root: string }
  | { id: string; ok: false; error: string };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<string, { resolve: (root: string) => void; reject: (error: Error) => void }>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./cryptoPerf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.root);
      else entry.reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'CRYPTO_WORKER_ERROR');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    worker = null;
    return null;
  }
}

async function buildMerkleRootFallback(leaves: string[]): Promise<string> {
  return (await buildMerkleTree(leaves)).root;
}

/**
 * Build a Merkle root without blocking the UI for large KT epochs.
 * Small batches stay in-process to avoid worker startup overhead.
 */
export async function buildMerkleRootForAudit(leaves: string[]): Promise<string> {
  if (leaves.length < 128) return buildMerkleRootFallback(leaves);
  const w = getWorker();
  if (!w) return buildMerkleRootFallback(leaves);
  const id = `kt-${Date.now()}-${++seq}`;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, type: 'buildMerkleRoot', leaves });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }).catch(() => buildMerkleRootFallback(leaves));
}

export function stopCryptoPerfWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
