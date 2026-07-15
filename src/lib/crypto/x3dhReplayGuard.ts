/**
 * X3DH anti-replay guard (Signal X3DH §4.6), implemented in two phases.
 *
 * reserve  -> derive/decrypt/persist without consuming the OPK
 * finalize -> mark the tuple consumed after AEAD authentication succeeds
 * cancel   -> release a failed reservation so a legitimate retransmission works
 */
import { hardCrypto } from './cryptoIntegrity';
import { encodeString } from './utils';
import { supabase } from '@/integrations/supabase/client';
import { runTxOn } from './indexedDbTx';

const STORE = 'consumed-initials';
const FINALIZED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 2 * 60 * 1000;
const SERVER_LEDGER_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

let serverLedgerDisabledUntil = 0;

interface ReplayRecord {
  id: string;
  status?: 'reserved' | 'finalized';
  reservationToken?: string;
  expiresAt?: number;
  consumedAt?: number;
}

export interface X3DHReplayReservation {
  fingerprint: string;
  localToken: string;
  serverToken: string | null;
  serverMode: 'two_phase' | 'legacy_finalize' | 'local_only';
}

function disableServerLedgerTemporarily(): void {
  serverLedgerDisabledUntil = Date.now() + SERVER_LEDGER_FAILURE_BACKOFF_MS;
}

export function __resetReplayLedgerServerBackoffForTests(): void {
  serverLedgerDisabledUntil = 0;
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
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isMissingRpc(error: any, name: string): boolean {
  const text = [error?.code, error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes('42883') || (text.includes(name.toLowerCase()) && text.includes('does not exist'));
}

/**
 * Every read/check/write stays inside one active IndexedDB transaction. This is
 * event-driven because Safari may auto-close a transaction between microtasks.
 */
async function reserveLocally(id: string, localToken: string): Promise<void> {
  const now = Date.now();
  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const get = store.get(id) as IDBRequest<ReplayRecord | undefined>;
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const existing = get.result;
        const finalizedAt = existing?.consumedAt ?? 0;
        if (
          existing &&
          (existing.status === 'finalized' || (!existing.status && finalizedAt > 0)) &&
          now - finalizedAt < FINALIZED_TTL_MS
        ) {
          reject(new Error('X3DH_REPLAY_DETECTED'));
          return;
        }
        if (existing?.status === 'reserved' && (existing.expiresAt ?? 0) > now) {
          reject(new Error('X3DH_REPLAY_IN_FLIGHT'));
          return;
        }

        const put = store.put({
          id,
          status: 'reserved',
          reservationToken: localToken,
          expiresAt: now + RESERVATION_TTL_MS,
        } satisfies ReplayRecord);
        put.onerror = () => reject(put.error);
        put.onsuccess = () => resolve();
      };
    }),
  );
}

async function deleteLocalReservation(id: string, localToken: string): Promise<void> {
  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const get = store.get(id) as IDBRequest<ReplayRecord | undefined>;
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const existing = get.result;
        if (existing?.status !== 'reserved' || existing.reservationToken !== localToken) {
          resolve();
          return;
        }
        const del = store.delete(id);
        del.onerror = () => reject(del.error);
        del.onsuccess = () => resolve();
      };
    }),
  );
}

async function finalizeLocally(reservation: X3DHReplayReservation): Promise<void> {
  const now = Date.now();
  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const get = store.get(reservation.fingerprint) as IDBRequest<ReplayRecord | undefined>;
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const existing = get.result;
        if (
          !existing ||
          existing.status !== 'reserved' ||
          existing.reservationToken !== reservation.localToken ||
          (existing.expiresAt ?? 0) <= now
        ) {
          reject(new Error('X3DH_REPLAY_RESERVATION_LOST'));
          return;
        }
        const put = store.put({
          id: reservation.fingerprint,
          status: 'finalized',
          consumedAt: now,
          expiresAt: now + FINALIZED_TTL_MS,
        } satisfies ReplayRecord);
        put.onerror = () => reject(put.error);
        put.onsuccess = () => resolve();
      };
    }),
  );
}

export async function reserveX3dhInitial(params: {
  myUserId: string;
  ik: string;
  ek: string;
  spkId: number;
  opkId?: number;
}): Promise<X3DHReplayReservation> {
  const id = await fingerprint(params.myUserId, params.ik, params.ek, params.spkId, params.opkId);
  const localToken = crypto.randomUUID();
  await reserveLocally(id, localToken);

  let serverMode: X3DHReplayReservation['serverMode'] = 'local_only';
  let serverToken: string | null = null;

  if (Date.now() >= serverLedgerDisabledUntil) {
    try {
      const { data, error } = await (supabase as any).rpc('reserve_x3dh_initial', {
        p_fingerprint: id,
        p_ttl_seconds: Math.ceil(RESERVATION_TTL_MS / 1000),
      });
      if (error) {
        if (isMissingRpc(error, 'reserve_x3dh_initial')) {
          serverMode = 'legacy_finalize';
        } else {
          disableServerLedgerTemporarily();
        }
      } else if (data?.ok === true && data?.reservation_token) {
        serverMode = 'two_phase';
        serverToken = String(data.reservation_token);
      } else {
        await deleteLocalReservation(id, localToken);
        throw new Error(data?.state === 'busy' ? 'X3DH_REPLAY_IN_FLIGHT' : 'X3DH_REPLAY_DETECTED');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'X3DH_REPLAY_DETECTED' || error.message === 'X3DH_REPLAY_IN_FLIGHT')
      ) {
        throw error;
      }
      disableServerLedgerTemporarily();
    }
  }

  return { fingerprint: id, localToken, serverToken, serverMode };
}

export async function finalizeX3dhInitial(
  reservation: X3DHReplayReservation,
): Promise<void> {
  let serverFinalized = false;

  if (reservation.serverMode === 'two_phase' && reservation.serverToken) {
    try {
      const { data, error } = await (supabase as any).rpc('finalize_x3dh_initial', {
        p_fingerprint: reservation.fingerprint,
        p_reservation_token: reservation.serverToken,
      });
      if (!error && data === true) {
        serverFinalized = true;
      } else if (!error && data === false) {
        throw new Error('X3DH_REPLAY_FINALIZE_REJECTED');
      } else {
        disableServerLedgerTemporarily();
        console.warn('[X3DH][REPLAY][SERVER] finalize unavailable — local finalized guard remains authoritative', error?.message);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'X3DH_REPLAY_FINALIZE_REJECTED') throw error;
      disableServerLedgerTemporarily();
      console.warn('[X3DH][REPLAY][SERVER] finalize transport failure — local guard only', error);
    }
  } else if (reservation.serverMode === 'legacy_finalize') {
    try {
      const { data: claimed, error } = await supabase.rpc('claim_x3dh_initial', {
        p_fingerprint: reservation.fingerprint,
      });
      if (!error && claimed === false) throw new Error('X3DH_REPLAY_DETECTED');
      if (!error && claimed === true) serverFinalized = true;
      if (error && !isMissingRpc(error, 'claim_x3dh_initial')) {
        disableServerLedgerTemporarily();
        console.warn('[X3DH][REPLAY][SERVER] legacy finalize unavailable — local guard only', error.message);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'X3DH_REPLAY_DETECTED') throw error;
      disableServerLedgerTemporarily();
    }
  }

  try {
    await finalizeLocally(reservation);
  } catch (error) {
    // If the authoritative server already finalized the tuple, replay safety is
    // preserved across reloads even if local storage was concurrently wiped.
    if (serverFinalized) {
      console.warn('[X3DH][REPLAY] local finalize failed after authoritative server success', error);
      return;
    }
    throw error;
  }
}

export async function cancelX3dhInitial(
  reservation: X3DHReplayReservation,
): Promise<void> {
  if (reservation.serverMode === 'two_phase' && reservation.serverToken) {
    try {
      await (supabase as any).rpc('cancel_x3dh_initial', {
        p_fingerprint: reservation.fingerprint,
        p_reservation_token: reservation.serverToken,
      });
    } catch {
      // Local release still matters. The server reservation has a short TTL.
    }
  }
  await deleteLocalReservation(reservation.fingerprint, reservation.localToken);
}

/** Compatibility for legacy account-level X3DH callers. */
export async function assertNotReplayedAndRecord(params: {
  myUserId: string;
  ik: string;
  ek: string;
  spkId: number;
  opkId?: number;
}): Promise<void> {
  const reservation = await reserveX3dhInitial(params);
  await finalizeX3dhInitial(reservation);
}
