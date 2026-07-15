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
import { runTxOn, reqToPromise } from './indexedDbTx';

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
  return text.includes('42883') || text.includes(name.toLowerCase()) && text.includes('does not exist');
}

async function deleteLocalReservation(id: string, localToken: string): Promise<void> {
  await runTxOn('x3dh-replay', [STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE);
    const existing = await reqToPromise(store.get(id) as IDBRequest<ReplayRecord | undefined>);
    if (existing?.status === 'reserved' && existing.reservationToken === localToken) {
      store.delete(id);
    }
  }).catch(() => {});
}

async function reserveLocally(id: string, localToken: string): Promise<void> {
  const now = Date.now();
  await runTxOn('x3dh-replay', [STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE);
    const existing = await reqToPromise(store.get(id) as IDBRequest<ReplayRecord | undefined>);

    // Records written by the previous one-phase implementation have consumedAt
    // but no status; treat them as finalized for compatibility.
    const finalizedAt = existing?.consumedAt ?? 0;
    if (
      existing &&
      (existing.status === 'finalized' || (!existing.status && finalizedAt > 0)) &&
      now - finalizedAt < FINALIZED_TTL_MS
    ) {
      throw new Error('X3DH_REPLAY_DETECTED');
    }
    if (
      existing?.status === 'reserved' &&
      (existing.expiresAt ?? 0) > now
    ) {
      throw new Error('X3DH_REPLAY_IN_FLIGHT');
    }

    store.put({
      id,
      status: 'reserved',
      reservationToken: localToken,
      expiresAt: now + RESERVATION_TTL_MS,
    } satisfies ReplayRecord);
  });
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
  if (reservation.serverMode === 'two_phase' && reservation.serverToken) {
    const { data, error } = await (supabase as any).rpc('finalize_x3dh_initial', {
      p_fingerprint: reservation.fingerprint,
      p_reservation_token: reservation.serverToken,
    });
    if (error || data !== true) {
      throw new Error(`X3DH_REPLAY_FINALIZE_FAILED:${error?.message ?? 'REJECTED'}`);
    }
  } else if (reservation.serverMode === 'legacy_finalize') {
    // Compatibility with databases that have not applied the two-phase
    // migration yet. Crucially this claim occurs after AEAD authentication.
    const { data: claimed, error } = await supabase.rpc('claim_x3dh_initial', {
      p_fingerprint: reservation.fingerprint,
    });
    if (error && !isMissingRpc(error, 'claim_x3dh_initial')) {
      throw new Error(`X3DH_REPLAY_FINALIZE_FAILED:${error.message}`);
    }
    if (!error && claimed === false) throw new Error('X3DH_REPLAY_DETECTED');
  }

  const now = Date.now();
  await runTxOn('x3dh-replay', [STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE);
    const existing = await reqToPromise(store.get(reservation.fingerprint) as IDBRequest<ReplayRecord | undefined>);
    if (
      !existing ||
      existing.status !== 'reserved' ||
      existing.reservationToken !== reservation.localToken ||
      (existing.expiresAt ?? 0) <= now
    ) {
      throw new Error('X3DH_REPLAY_RESERVATION_LOST');
    }
    store.put({
      id: reservation.fingerprint,
      status: 'finalized',
      consumedAt: now,
      expiresAt: now + FINALIZED_TTL_MS,
    } satisfies ReplayRecord);
  });
}

export async function cancelX3dhInitial(
  reservation: X3DHReplayReservation,
): Promise<void> {
  if (reservation.serverMode === 'two_phase' && reservation.serverToken) {
    await (supabase as any).rpc('cancel_x3dh_initial', {
      p_fingerprint: reservation.fingerprint,
      p_reservation_token: reservation.serverToken,
    }).catch(() => undefined);
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
