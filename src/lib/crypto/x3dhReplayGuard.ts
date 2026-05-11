/**
 * X3DH Anti-Replay Guard (Signal X3DH spec §4.6)
 *
 * Prevents replay of an X3DH initial message: even if the local OPK delete
 * silently fails, the same `(IKa, EKa, spkId, opkId)` tuple cannot be
 * processed twice by the responder.
 *
 * Storage: dedicated IndexedDB store via dbRegistry, TTL 7 days.
 * Cost: 1 SHA-256 + 1 IDB get/put per inbound X3DH message.
 */

import { hardCrypto } from './cryptoIntegrity';
import { encodeString } from './utils';
import { supabase } from '@/integrations/supabase/client';
import { runTxOn, reqToPromise } from './indexedDbTx';

const STORE = 'consumed-initials';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ReplayRecord {
  id: string;
  consumedAt: number;
}

async function fingerprint(
  myUserId: string,
  ik: string,
  ek: string,
  spkId: number,
  opkId: number | undefined,
): Promise<string> {
  const material = `${myUserId}|${ik}|${ek}|${spkId}|${opkId ?? 'none'}`;
  const hash = await hardCrypto.digest('SHA-256', encodeString(material));
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Throws `X3DH_REPLAY_DETECTED` if this initial message was already consumed.
 * Otherwise records it and returns. Best-effort GC of expired entries.
 */
export async function assertNotReplayedAndRecord(params: {
  myUserId: string;
  ik: string;
  ek: string;
  spkId: number;
  opkId?: number;
}): Promise<void> {
  const id = await fingerprint(params.myUserId, params.ik, params.ek, params.spkId, params.opkId);

  // ─── Server-side ledger first (authoritative, defeats local IDB wipe) ───
  try {
    const { data: claimed, error } = await supabase.rpc('claim_x3dh_initial', {
      p_fingerprint: id,
    });
    if (error) {
      console.warn('[X3DH][REPLAY][SERVER] RPC error — relying on local guard only', error.message);
    } else if (claimed === false) {
      console.error('[X3DH][REPLAY][SERVER] ⛔ duplicate initial message rejected by ledger', {
        spkId: params.spkId,
        opkId: params.opkId ?? null,
      });
      throw new Error('X3DH_REPLAY_DETECTED');
    }
  } catch (err: any) {
    if (err?.message === 'X3DH_REPLAY_DETECTED') throw err;
    console.warn('[X3DH][REPLAY][SERVER] ledger unavailable — local guard only', err?.message ?? err);
  }

  let existing: ReplayRecord | undefined;
  try {
    existing = await runTxOn('x3dh-replay', [STORE], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE).get(id) as IDBRequest<ReplayRecord | undefined>),
    );
  } catch {
    console.warn('[X3DH][REPLAY] IDB unavailable — server ledger is the only line of defense');
    return;
  }

  if (existing) {
    const ageMs = Date.now() - existing.consumedAt;
    if (ageMs < TTL_MS) {
      console.error('[X3DH][REPLAY] ⛔ duplicate initial message rejected', {
        spkId: params.spkId,
        opkId: params.opkId ?? null,
        ageMs,
      });
      throw new Error('X3DH_REPLAY_DETECTED');
    }
  }

  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).put({ id, consumedAt: Date.now() } as ReplayRecord);
  });

  // Best-effort GC (sample 1/10 to keep cost low)
  if (Math.random() < 0.1) {
    try {
      await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) => {
        const store = tx.objectStore(STORE);
        const cursorReq = store.openCursor();
        const cutoff = Date.now() - TTL_MS;
        let purged = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            if (purged > 0) console.log(`[X3DH][REPLAY][GC] purged ${purged} expired entries`);
            return;
          }
          const rec = cursor.value as ReplayRecord;
          if (rec.consumedAt < cutoff) {
            cursor.delete();
            purged++;
          }
          cursor.continue();
        };
      });
    } catch { /* non-fatal */ }
  }
}
