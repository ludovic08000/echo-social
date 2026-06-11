/**
 * Session store — façade over the device-pair Double Ratchet store
 * (`forsure-device-sessions`).
 *
 * Sesame rule: a session = a (selfDevice, peerDevice) pair. Sessions are
 * NEVER deleted automatically by this layer — old skipped keys / old
 * ratchet states are required to read historical messages after key restore.
 *
 * The actual ratchet state lives in `src/lib/crypto/deviceRatchet.ts`. This
 * module exposes a stable id-based view + status tracking.
 */
import type { SessionDescriptor, SessionId, UserId, DeviceId } from './types';
import { getSessionPeerSpkId } from '@/lib/crypto/deviceRatchet';

const STATUS_KEY = 'forsure-session-status-v1';

interface StatusEntry {
  status: 'active' | 'inactive' | 'archived';
  layer: SessionDescriptor['layer'];
  createdAt: number;
  lastUsedAt: number;
}

function loadStatusMap(): Record<SessionId, StatusEntry> {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Persist the status map atomically. Reads the on-disk version first and
 * merges so that concurrent tabs cannot trample each other's lastUsedAt /
 * status updates. Strict last-write-wins on `lastUsedAt`.
 */
function saveStatusMap(map: Record<SessionId, StatusEntry>): void {
  try {
    let onDisk: Record<SessionId, StatusEntry> = {};
    try {
      const raw = localStorage.getItem(STATUS_KEY);
      onDisk = raw ? JSON.parse(raw) : {};
    } catch { /* corrupt map — overwrite */ }

    const merged: Record<SessionId, StatusEntry> = { ...onDisk };
    for (const [id, entry] of Object.entries(map)) {
      const prev = merged[id];
      if (!prev || (entry.lastUsedAt ?? 0) >= (prev.lastUsedAt ?? 0)) {
        merged[id] = entry;
      }
    }
    localStorage.setItem(STATUS_KEY, JSON.stringify(merged));
  } catch {
    /* quota — non-fatal */
  }
}

/** Stable id for a (self, peer) device pair. Symmetric for both endpoints. */
export function makeSessionId(
  selfUserId: UserId, selfDeviceId: DeviceId,
  peerUserId: UserId, peerDeviceId: DeviceId,
): SessionId {
  // Order-independent so both sides compute the same id.
  const a = `${selfUserId}::${selfDeviceId}`;
  const b = `${peerUserId}::${peerDeviceId}`;
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

export function describeSession(
  selfUserId: UserId, selfDeviceId: DeviceId,
  peerUserId: UserId, peerDeviceId: DeviceId,
): SessionDescriptor {
  const sessionId = makeSessionId(selfUserId, selfDeviceId, peerUserId, peerDeviceId);
  const map = loadStatusMap();
  const entry = map[sessionId];
  return {
    sessionId,
    selfUserId, selfDeviceId,
    peerUserId, peerDeviceId,
    status: entry?.status ?? 'inactive',
    layer: entry?.layer ?? 'x3dh-bootstrap',
    createdAt: entry?.createdAt ?? Date.now(),
    lastUsedAt: entry?.lastUsedAt ?? 0,
  };
}

export function markSessionUsed(
  sessionId: SessionId,
  layer: SessionDescriptor['layer'],
): void {
  const map = loadStatusMap();
  const prev = map[sessionId];
  map[sessionId] = {
    status: 'active',
    layer,
    createdAt: prev?.createdAt ?? Date.now(),
    lastUsedAt: Date.now(),
  };
  saveStatusMap(map);
}

export function archiveSession(sessionId: SessionId): void {
  const map = loadStatusMap();
  if (!map[sessionId]) return;
  // Sesame: never delete — only archive. Old skipped keys still readable.
  map[sessionId] = { ...map[sessionId], status: 'archived' };
  saveStatusMap(map);
}

/**
 * Did the peer rotate its SignedPreKey since we cached this session?
 * Delegates to the existing ratchet store so we have one source of truth.
 */
export async function getCachedPeerSpkId(
  selfUserId: UserId, selfDeviceId: DeviceId,
  peerUserId: UserId, peerDeviceId: DeviceId,
): Promise<number | null> {
  try {
    return await getSessionPeerSpkId(selfUserId, selfDeviceId, peerUserId, peerDeviceId);
  } catch {
    return null;
  }
}
