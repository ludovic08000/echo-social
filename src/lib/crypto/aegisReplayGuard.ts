/**
 * Aegis X3DH anti-replay ledger.
 *
 * The authenticated server owns the global reservation. IndexedDB mirrors the
 * state so duplicate work is also rejected immediately inside one device.
 * There is deliberately no account-wide or offline compatibility path.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import { runTxOn } from './indexedDbTx';
import { encodeString } from './utils';

const STORE = 'consumed-initials';
const FINALIZED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 2 * 60 * 1000;

interface ReplayRecord {
  id: string;
  status: 'reserved' | 'finalized';
  reservationToken?: string;
  expiresAt: number;
  consumedAt?: number;
}

export interface AegisReplayReservation {
  fingerprint: string;
  localToken: string;
  serverToken: string;
}

interface ReplayReservationResponse {
  ok?: boolean;
  state?: string;
  reservation_token?: string;
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

async function reserveLocally(id: string, token: string): Promise<void> {
  const now = Date.now();
  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const get = store.get(id) as IDBRequest<ReplayRecord | undefined>;
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const existing = get.result;
        if (existing?.status === 'finalized' && (existing.consumedAt ?? 0) + FINALIZED_TTL_MS > now) {
          reject(new Error('X3DH_REPLAY_DETECTED'));
          return;
        }
        if (existing?.status === 'reserved' && existing.expiresAt > now) {
          reject(new Error('X3DH_REPLAY_IN_FLIGHT'));
          return;
        }
        const put = store.put({
          id,
          status: 'reserved',
          reservationToken: token,
          expiresAt: now + RESERVATION_TTL_MS,
        } satisfies ReplayRecord);
        put.onerror = () => reject(put.error);
        put.onsuccess = () => resolve();
      };
    }),
  );
}

async function deleteLocalReservation(id: string, token: string): Promise<void> {
  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const get = store.get(id) as IDBRequest<ReplayRecord | undefined>;
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const existing = get.result;
        if (existing?.status !== 'reserved' || existing.reservationToken !== token) {
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

async function finalizeLocally(reservation: AegisReplayReservation): Promise<void> {
  const now = Date.now();
  await runTxOn('x3dh-replay', [STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const get = store.get(reservation.fingerprint) as IDBRequest<ReplayRecord | undefined>;
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const existing = get.result;
        if (
          existing?.status !== 'reserved' ||
          existing.reservationToken !== reservation.localToken ||
          existing.expiresAt <= now
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

export async function reserveAegisInitial(params: {
  myUserId: string;
  ik: string;
  ek: string;
  spkId: number;
  opkId?: number;
}): Promise<AegisReplayReservation> {
  const id = await fingerprint(params.myUserId, params.ik, params.ek, params.spkId, params.opkId);
  const localToken = crypto.randomUUID();
  await reserveLocally(id, localToken);

  try {
    const { data, error } = await supabase.rpc('reserve_x3dh_initial', {
      p_fingerprint: id,
      p_ttl_seconds: Math.ceil(RESERVATION_TTL_MS / 1000),
    });
    if (error) throw error;
    const response = data as ReplayReservationResponse | null;
    if (response?.ok !== true || !response.reservation_token) {
      throw new Error(response?.state === 'busy' ? 'X3DH_REPLAY_IN_FLIGHT' : 'X3DH_REPLAY_DETECTED');
    }
    return {
      fingerprint: id,
      localToken,
      serverToken: response.reservation_token,
    };
  } catch (error) {
    await deleteLocalReservation(id, localToken).catch(() => undefined);
    if (
      error instanceof Error &&
      (error.message === 'X3DH_REPLAY_DETECTED' || error.message === 'X3DH_REPLAY_IN_FLIGHT')
    ) {
      throw error;
    }
    throw new Error(`AEGIS_REPLAY_LEDGER_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function finalizeAegisInitial(reservation: AegisReplayReservation): Promise<void> {
  const { data, error } = await supabase.rpc('finalize_x3dh_initial', {
    p_fingerprint: reservation.fingerprint,
    p_reservation_token: reservation.serverToken,
  });
  if (error) throw new Error(`AEGIS_REPLAY_FINALIZE_UNAVAILABLE: ${error.message ?? String(error)}`);
  if (data !== true) throw new Error('X3DH_REPLAY_FINALIZE_REJECTED');

  // The server is authoritative once it accepted the tuple.
  await finalizeLocally(reservation).catch((localError) => {
    console.warn('[AEGIS][REPLAY] local mirror finalize failed after server success', localError);
  });
}

export async function cancelAegisInitial(reservation: AegisReplayReservation): Promise<void> {
  try {
    await supabase.rpc('cancel_x3dh_initial', {
      p_fingerprint: reservation.fingerprint,
      p_reservation_token: reservation.serverToken,
    });
  } finally {
    await deleteLocalReservation(reservation.fingerprint, reservation.localToken);
  }
}
