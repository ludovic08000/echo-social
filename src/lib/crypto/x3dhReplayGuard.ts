/**
 * X3DH Anti-Replay Guard (Signal X3DH spec §4.6)
 *
 * Prevents replay of an X3DH initial message: even if the local OPK delete
 * silently fails, the same `(IKa, EKa, spkId, opkId)` tuple cannot be
 * processed twice by the responder.
 *
 * Storage: dedicated IndexedDB store, TTL 7 days (matches SPK lifetime).
 * Cost: 1 SHA-256 + 1 IDB get/put per inbound X3DH message.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { encodeString } from './utils';
import { supabase } from '@/integrations/supabase/client';

const DB_NAME = 'forsure-x3dh-replay';
const DB_VERSION = 1;
const STORE = 'consumed-initials';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ReplayRecord {
  id: string;
  consumedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = hardGlobals.idbOpen(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
  });
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
  // Signal X3DH §4.6 + WhatsApp Whitepaper §"Initial Sessions" — server MUST also
  // refuse to deliver a duplicate initial bundle. Best-effort: if RPC fails for
  // network reasons we still fall back to the local guard below.
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

  let db: IDBDatabase;
  try {
    db = await openDB();
  } catch {
    // IndexedDB unavailable (private mode, quota issue): server ledger above is
    // the source of truth; if it also failed we fail-open with a warn.
    console.warn('[X3DH][REPLAY] IDB unavailable — server ledger is the only line of defense');
    return;
  }

  // (id already computed above)

  const id = await fingerprint(params.myUserId, params.ik, params.ek, params.spkId, params.opkId);

  // Check existing
  const existing = await new Promise<ReplayRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

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
    // expired record → fall through and overwrite
  }

  // Record + opportunistic GC
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ id, consumedAt: Date.now() } as ReplayRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Best-effort GC (sample 1/10 to keep cost low)
  if (Math.random() < 0.1) {
    try {
      const tx = db.transaction(STORE, 'readwrite');
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
    } catch { /* non-fatal */ }
  }
}
