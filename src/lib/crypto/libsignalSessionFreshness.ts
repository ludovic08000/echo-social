import { runCrossTabExclusive } from './crossTabLock';
import { readDeviceVaultRecord, writeDeviceVaultRecord } from './deviceVault';

export type LibsignalSessionOwner = {
  ownerUserId: string; ownerDeviceId: string; remoteUserId: string; remoteDeviceId: string;
};
type Revision = { token: string };
const validRevision = (value: unknown): value is Revision => typeof value === 'object'
  && value !== null && typeof (value as Revision).token === 'string' && (value as Revision).token.length > 0;
const pending = new Map<string, Map<string, Revision>>();
const id = (parts: string[]) => `aegis:libsignal-freshness:${JSON.stringify(parts)}`;
const ownerId = (userId: string) => id(['owner', userId]);
const peerId = (args: LibsignalSessionOwner) => id(['peer', args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId]);
const appliedId = (args: LibsignalSessionOwner) => id(['applied', args.ownerUserId, args.ownerDeviceId, args.remoteUserId, args.remoteDeviceId]);
const lock = <T>(userId: string, work: () => Promise<T>) =>
  runCrossTabExclusive(`aegis:libsignal-freshness-lock:${userId}`, work);

async function commit(key: string, revision: Revision): Promise<void> {
  await writeDeviceVaultRecord(key, revision);
  const check = await readDeviceVaultRecord(key, validRevision);
  if (check?.token !== revision.token) throw new Error('AEGIS_LIBSIGNAL_INVALIDATION_COMMIT_FAILED');
}

async function flushPending(userId: string): Promise<void> {
  const changes = pending.get(userId);
  if (!changes) return;
  for (const [key, revision] of changes) {
    await commit(key, revision);
    if (changes.get(key) === revision) changes.delete(key);
  }
  if (changes.size === 0) pending.delete(userId);
}

function invalidate(userId: string, key: string): Promise<void> {
  if (!userId) return Promise.reject(new Error('AEGIS_LIBSIGNAL_INVALIDATION_OWNER_REQUIRED'));
  const changes = pending.get(userId) ?? new Map<string, Revision>();
  changes.set(key, { token: crypto.randomUUID() });
  pending.set(userId, changes);
  return lock(userId, () => flushPending(userId));
}

/** Invalider exige un nouveau handshake, jamais l'effacement du coffre ou des identités connues. */
export function invalidateLibsignalSessions(userId: string): Promise<void> {
  return invalidate(userId, ownerId(userId));
}

export function invalidateLibsignalDeviceSession(ownerUserId: string, ownerDeviceId: string, remoteUserId: string, remoteDeviceId: string): Promise<void> {
  return invalidate(ownerUserId, peerId({ ownerUserId, ownerDeviceId, remoteUserId, remoteDeviceId }));
}

export function withLibsignalSessionFreshness<T>(
  args: LibsignalSessionOwner,
  work: (renew: boolean, established: () => Promise<void>) => Promise<T>,
): Promise<T> {
  // L'invalidation et le handshake sont sérialisés entre onglets ; le verrou
  // du store reste interne au bridge et n'est jamais repris récursivement.
  return lock(args.ownerUserId, async () => {
    await flushPending(args.ownerUserId);
    const owner = await readDeviceVaultRecord(ownerId(args.ownerUserId), validRevision);
    const peer = await readDeviceVaultRecord(peerId(args), validRevision);
    const applied = await readDeviceVaultRecord(appliedId(args), validRevision);
    const token = JSON.stringify([owner?.token ?? null, peer?.token ?? null]);
    const renew = Boolean(owner || peer) && applied?.token !== token;
    return work(renew, () => commit(appliedId(args), { token }));
  });
}
