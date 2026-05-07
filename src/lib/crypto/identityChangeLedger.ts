// Lot A4 — TOFU + identity-change ledger.
//
// When a peer's identity fingerprint changes vs the previously trusted one,
// we record an event in `user_identity_change_events` so the chat UI can
// surface a Signal-style banner ("X's safety number has changed"). The user
// can acknowledge the change to clear the banner.

import { supabase } from '@/integrations/supabase/client';

export interface IdentityChangeEvent {
  id: number;
  peerUserId: string;
  previousFingerprint: string | null;
  newFingerprint: string;
  acknowledged: boolean;
  observedAt: string;
}

/** Record a peer's fingerprint rotation. Idempotent within ~5 min via dedup. */
export async function recordIdentityChange(params: {
  observerUserId: string;
  peerUserId: string;
  previousFingerprint: string | null;
  newFingerprint: string;
}): Promise<void> {
  // Dedup: skip if an unacknowledged event with same new fp already exists.
  const { data: existing } = await supabase
    .from('user_identity_change_events' as any)
    .select('id')
    .eq('observer_user_id', params.observerUserId)
    .eq('peer_user_id', params.peerUserId)
    .eq('new_fingerprint', params.newFingerprint)
    .eq('acknowledged', false)
    .limit(1)
    .maybeSingle();
  if (existing) return;

  await supabase.from('user_identity_change_events' as any).insert({
    observer_user_id: params.observerUserId,
    peer_user_id: params.peerUserId,
    previous_fingerprint: params.previousFingerprint,
    new_fingerprint: params.newFingerprint,
  });
}

export async function fetchUnacknowledgedIdentityChanges(
  observerUserId: string,
  peerUserId?: string,
): Promise<IdentityChangeEvent[]> {
  let q = supabase
    .from('user_identity_change_events' as any)
    .select('id, peer_user_id, previous_fingerprint, new_fingerprint, acknowledged, observed_at')
    .eq('observer_user_id', observerUserId)
    .eq('acknowledged', false)
    .order('observed_at', { ascending: false });
  if (peerUserId) q = q.eq('peer_user_id', peerUserId);
  const { data } = await q;
  return ((data || []) as any[]).map((r) => ({
    id: r.id,
    peerUserId: r.peer_user_id,
    previousFingerprint: r.previous_fingerprint,
    newFingerprint: r.new_fingerprint,
    acknowledged: r.acknowledged,
    observedAt: r.observed_at,
  }));
}

export async function acknowledgeIdentityChange(eventId: number): Promise<void> {
  await supabase
    .from('user_identity_change_events' as any)
    .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
    .eq('id', eventId);
}

export async function acknowledgeAllForPeer(observerUserId: string, peerUserId: string): Promise<void> {
  await supabase
    .from('user_identity_change_events' as any)
    .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
    .eq('observer_user_id', observerUserId)
    .eq('peer_user_id', peerUserId)
    .eq('acknowledged', false);
}
