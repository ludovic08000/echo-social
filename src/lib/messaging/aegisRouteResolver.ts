/**
 * Aegis client route resolver. Server route membership is re-verified against
 * the canonical user_devices registry before any destination is used.
 */
import { supabase } from '@/integrations/supabase/client';
import { verifyRouteDeviceIdentityOffline } from '@/lib/crypto/deviceLinkTrust';
import type { DeviceDescriptor } from '@/e2ee-session/types';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

type RouteDeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string | null;
  device_authorization_signature: string | null;
  account_identity_key: string | null;
  account_signing_key: string | null;
  account_fingerprint: string | null;
  account_binding_signature: string | null;
  account_binding_version: number | null;
  last_seen_at: string | null;
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
  targets: DeviceDescriptor[];
  senderDeviceRoutable: boolean;
  unroutableUserIds: string[];
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
  } catch {
    // best effort only
  }
}

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
    throw new Error('E2EE_ROUTE_VERSION_UNAVAILABLE');
  }

  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  const targets: DeviceDescriptor[] = [];
  const unroutableUserIds: string[] = [];

  for (const participant of participants) {
    const rows = (Array.isArray(participant.devices) ? participant.devices : [])
      .filter((row) => row.is_routable === true);

    if (rows.length === 0) {
      if (!participant.is_self) unroutableUserIds.push(participant.user_id);
      continue;
    }

    const verified = await Promise.all(rows.map(async (row) => ({
      row,
      identity: await verifyRouteDeviceIdentityOffline({
        userId: participant.user_id,
        deviceId: row.device_id,
        devicePublicKey: row.device_public_key,
        deviceSigningKey: row.device_signing_key,
        deviceAuthorizationSignature: row.device_authorization_signature,
        accountIdentityKey: row.account_identity_key,
        accountSigningKey: row.account_signing_key,
        accountFingerprint: row.account_fingerprint,
        accountBindingSignature: row.account_binding_signature,
        accountBindingVersion: row.account_binding_version,
      }),
    })));

    const rejectedSelf = participant.is_self
      && verified.some(({ row, identity }) => row.device_id === senderDeviceId && !identity);
    if (rejectedSelf) requestSelfRepair('invalid_device_authorization', senderDeviceId);

    const accepted = verified.filter(({ row, identity }) =>
      Boolean(identity) && !(participant.is_self && row.device_id === senderDeviceId));

    trace('ROUTE_CANONICAL_TRUST_VERIFIED', {
      outcome: accepted.length === rows.length ? 'ok' : 'retry',
      targetCount: rows.length,
      copyCount: accepted.length,
    }, accepted.length === rows.length ? 'info' : 'warn');

    if (!participant.is_self && accepted.length === 0) {
      unroutableUserIds.push(participant.user_id);
      continue;
    }

    for (const { row, identity } of accepted) {
      if (!identity) continue;
      targets.push({
        userId: participant.user_id,
        deviceId: identity.deviceId,
        devicePublicKey: identity.devicePublicKey,
        lastSeen: normalizeLastSeen(row.last_seen_at),
      });
    }
  }

  if (payload.sender_device_routable === false) {
    requestSelfRepair('sender_device_not_routable', senderDeviceId);
  }

  trace('ROUTE_RESOLVED', {
    outcome: unroutableUserIds.length > 0 ? 'retry' : 'ok',
    targetCount: targets.length,
    copyCount: unroutableUserIds.length,
    senderUserId,
  }, unroutableUserIds.length > 0 ? 'warn' : 'info');

  return {
    version: payload.route_version,
    targets,
    senderDeviceRoutable: payload.sender_device_routable === true,
    unroutableUserIds,
  };
}
