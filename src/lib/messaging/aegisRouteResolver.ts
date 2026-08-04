/**
 * Module de routage Aegis (côté client) — miroir de la RPC serveur
 * `aegis_resolve_conversation_route`.
 *
 * Invariant corrigé : la version de route et la liste des appareils sont lues
 * dans UN SEUL appel serveur, donc dans le même instantané transactionnel. Les
 * anciennes lectures séparées (version, puis appareils, puis version) pouvaient
 * diverger et bloquer l'envoi en `E2EE_DEVICE_LIST_STALE`.
 *
 * Le routage ne dépend d'aucune relation d'amitié : tout participant d'une
 * conversation (ami connu ou nouvel interlocuteur) est routé de la même façon.
 * La confiance reste fail-closed : chaque appareil renvoyé par le serveur est
 * re-vérifié localement (liaison d'identité de compte + signature d'autorisation
 * d'appareil) avant d'être accepté comme destination de chiffrement.
 */
import { supabase } from '@/integrations/supabase/client';
import { verifySignedDeviceList, type SignedDeviceEntry } from '@/lib/crypto/signedDeviceList';
import type { DeviceDescriptor } from '@/e2ee-session/types';

type RouteDeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string;
  device_authorization_signature: string;
  last_seen_at: string | null;
  account_identity_key: string;
  account_signing_key: string;
  account_fingerprint: string;
  account_binding_signature: string;
  account_binding_version: number;
  is_routable: boolean;
};

type RouteParticipantRow = {
  user_id: string;
  is_self: boolean;
  routable_count: number;
  total_count: number;
  reason: 'OK' | 'NO_DEVICE_IDENTITY' | 'DEVICES_NOT_ROUTABLE';
  devices: RouteDeviceRow[];
};

type RouteRpcPayload = {
  route_version: string;
  self_user_id: string;
  sender_device_id: string | null;
  sender_device_routable: boolean;
  participants: RouteParticipantRow[];
};

export interface ResolvedConversationRoute {
  version: string;
  /** Destinations vérifiées, sans l'appareil courant de l'expéditeur. */
  targets: DeviceDescriptor[];
  senderDeviceRoutable: boolean;
  /** Participants sans aucune destination exploitable. */
  unroutableUserIds: string[];
}

function toSignedEntry(row: RouteDeviceRow): SignedDeviceEntry {
  return {
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    deviceSigningKey: row.device_signing_key,
    authorizationSignature: row.device_authorization_signature,
    lastSeenAt: row.last_seen_at ?? null,
    accountIdentityKey: row.account_identity_key,
    accountSigningKey: row.account_signing_key,
    accountFingerprint: row.account_fingerprint,
    accountBindingSignature: row.account_binding_signature,
    accountBindingVersion: Number(row.account_binding_version),
    isRoutable: row.is_routable === true,
  };
}

function normalizeLastSeen(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

let lastSelfRepairAt = 0;
function requestSelfRepair(reason: string, deviceId: string | null): void {
  try {
    if (typeof window === 'undefined' || !deviceId) return;
    const now = Date.now();
    if (now - lastSelfRepairAt < 30_000) return;
    lastSelfRepairAt = now;
    window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
      detail: { reason, deviceId },
    }));
  } catch { /* best-effort */ }
}

/**
 * Résout la route complète d'une conversation. Aucune liste non signée n'est
 * jamais acceptée : un appareil dont la signature d'autorisation est invalide
 * est écarté du routage.
 */
export async function resolveConversationRoute(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<ResolvedConversationRoute> {
  const startedAt = Date.now();
  const trace = (
    stage: string,
    details: Record<string, unknown> = {},
    level: 'info' | 'warn' | 'error' = 'info',
  ) => traceE2EE({
    direction: 'send',
    component: 'route_resolver',
    stage,
    conversationId,
    deviceId: senderDeviceId,
    elapsedMs: Date.now() - startedAt,
    ...details,
  }, level);

  trace('ROUTE_RESOLVE', { outcome: 'start', transport: 'supabase' });
  const { data, error } = await (supabase as any).rpc('aegis_resolve_conversation_route', {
    p_conversation_id: conversationId,
    p_sender_device_id: senderDeviceId,
  });

  if (error) {
    trace('ROUTE_RESOLVE', { outcome: 'error', errorCode: error.message }, 'error');
    throw new Error(error.message || 'E2EE_ROUTE_RESOLUTION_FAILED');
  }

  const payload = data as RouteRpcPayload | null;
  if (!payload || typeof payload.route_version !== 'string' || payload.route_version.length < 8) {
    trace('ROUTE_RESOLVE', { outcome: 'error', errorCode: 'E2EE_ROUTE_VERSION_UNAVAILABLE' }, 'error');
    throw new Error('E2EE_ROUTE_VERSION_UNAVAILABLE');
  }

  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  trace('ROUTE_PARTICIPANTS', { outcome: 'ok', targetCount: participants.length });
  const targets: DeviceDescriptor[] = [];
  const unroutableUserIds: string[] = [];


  for (const participant of participants) {
    const rows = Array.isArray(participant.devices) ? participant.devices : [];
    const entries = rows.filter(row => row.is_routable === true).map(toSignedEntry);

    if (entries.length === 0) {
      // Un participant sans appareil routable n'est pas joignable : on ne
      // dégrade jamais vers un envoi en clair.
      if (!participant.is_self) unroutableUserIds.push(participant.user_id);
      continue;
    }

    const verifications = await verifySignedDeviceList(participant.user_id, entries);
    const trusted = new Set(verifications.filter(v => v.ok).map(v => v.deviceId));

    const accepted = entries.filter(entry =>
      trusted.has(entry.deviceId) &&
      !(participant.is_self && entry.deviceId === senderDeviceId),
    );

    if (participant.is_self && verifications.some(v => !v.ok && v.deviceId === senderDeviceId)) {
      requestSelfRepair('invalid_device_authorization', senderDeviceId);
    }

    if (!participant.is_self && accepted.length === 0) {
      unroutableUserIds.push(participant.user_id);
      continue;
    }

    for (const entry of accepted) {
      targets.push({
        userId: participant.user_id,
        deviceId: entry.deviceId,
        devicePublicKey: entry.devicePublicKey,
        lastSeen: normalizeLastSeen(entry.lastSeenAt),
      });
    }
  }

  if (payload.sender_device_routable === false) {
    requestSelfRepair('sender_device_not_routable', senderDeviceId);
  }

  return {
    version: payload.route_version,
    targets,
    senderDeviceRoutable: payload.sender_device_routable === true,
    unroutableUserIds,
  };
}
