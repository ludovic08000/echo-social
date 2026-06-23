/**
 * Ratchet IndexedDB persistence — extracted from useE2EE.ts.
 *
 * All access goes through `runTxOn('ratchet', ...)` (see dbRegistry/indexedDbTx)
 * for Safari-safe singleton + retry semantics.
 */

import { runTx, runTxOn, reqToPromise } from './indexedDbTx';
import { hardGlobals } from './cryptoIntegrity';
import { STORE_SESSION, STORE_PREKEYS } from './constants';
import {
  serializeRatchetState,
  deserializeRatchetState,
  type RatchetState,
  type X3DHInitialMessage,
} from '@/lib/crypto';

export const RATCHET_DB_NAME = 'forsure-ratchet';
export const RATCHET_DB_VERSION = 1;
export const RATCHET_STORE_NAME = 'ratchet-states';

export function recreateLegacyE2EEDatabase(): Promise<void> {
  return new Promise((resolve) => {
    void (async () => {
      try {
        const stores = [STORE_SESSION, STORE_PREKEYS];
        await runTx(stores, 'readwrite', (tx) => {
          for (const s of stores) {
            try { tx.objectStore(s).clear(); } catch {}
          }
        });
        console.log('[E2EE] Repaired IndexedDB schema and cleared transient crypto stores');
      } catch (error) {
        console.error('[E2EE] Failed to repair E2EE database — identity keys preserved', error);
      } finally {
        resolve();
      }
    })();
  });
}

export async function saveRatchetLocal(
  convId: string,
  state: RatchetState,
  x3dhHeader?: X3DHInitialMessage | null,
): Promise<void> {
  try {
    const json = await serializeRatchetState(state);
    const record: any = { convId, data: json };
    if (x3dhHeader !== undefined) {
      record.x3dhHeader = x3dhHeader ? hardGlobals.jsonStringify(x3dhHeader) : null;
    }
    await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
      tx.objectStore(RATCHET_STORE_NAME).put(record);
    });
  } catch (e) {
    console.error('[E2EE] Failed to persist ratchet state:', e);
  }
}

export async function loadRatchetLocal(
  convId: string,
): Promise<{ state: RatchetState; x3dhHeader: X3DHInitialMessage | null } | null> {
  try {
    const result = await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readonly', (tx) =>
      reqToPromise<any>(tx.objectStore(RATCHET_STORE_NAME).get(convId)),
    );
    if (!result?.data) return null;
    const state = await deserializeRatchetState(result.data);
    const x3dhHeader = result.x3dhHeader
      ? (hardGlobals.jsonParse(result.x3dhHeader) as X3DHInitialMessage)
      : null;
    return { state, x3dhHeader };
  } catch {
    return null;
  }
}

export async function deleteRatchetLocal(convId: string): Promise<void> {
  try {
    await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
      tx.objectStore(RATCHET_STORE_NAME).delete(convId);
    });
    console.info(`[E2EE] 🧹 Ratchet local purgé pour conv ${convId}`);
  } catch (e) {
    console.warn('[E2EE] deleteRatchetLocal failed:', e);
  }
}
