// Lot A4 — TOFU + identity-change ledger.
//
// When a peer's identity fingerprint changes vs the previously trusted one,
// we record an event in `user_identity_change_events` so the chat UI can
// surface a Signal-style banner ("X's safety number has changed"). The user
// can acknowledge the change to clear the banner.

import { supabase } from '@/integrations/supabase/client';

export type IdentityChangeType = 'identity_rotation' | 'recovery_restore';

export interface IdentityChangeEvent {
  id: number;
  peerUserId: string;
  previousFingerprint: string | null;
  newFingerprint: string;
  acknowledged: boolean;
  observedAt: string;
  changeType: IdentityChangeType;
}

/** Record a peer's fingerprint rotation. Idempotent within ~5 min via dedup. */
export async function recordIdentityChange(params: {
  observerUserId: string;
  peerUserId: string;
  previousFingerprint: string | null;
  newFingerprint: string;
  changeType?: IdentityChangeType;
}): Promise<void> {
  const changeType: IdentityChangeType = params.changeType ?? 'identity_rotation';
  // Dedup: skip if an unacknowledged event with same new fp already exists.
  const { data: existing } = await supabase
    .from('user_identity_change_events' as any)
    .select('id, change_type')
    .eq('observer_user_id', params.observerUserId)
    .eq('peer_user_id', params.peerUserId)
    .eq('new_fingerprint', params.newFingerprint)
    .eq('acknowledged', false)
    .limit(1)
    .maybeSingle();
  if (existing) {
    const existingType = (existing as any).change_type as IdentityChangeType | undefined;
    if (changeType === 'recovery_restore' && existingType !== 'recovery_restore') {
      await supabase
        .from('user_identity_change_events' as any)
        .update({ change_type: 'recovery_restore' })
        .eq('id', (existing as any).id);
    }
    return;
  }

  await supabase.from('user_identity_change_events' as any).insert({
    observer_user_id: params.observerUserId,
    peer_user_id: params.peerUserId,
    previous_fingerprint: params.previousFingerprint,
    new_fingerprint: params.newFingerprint,
    change_type: changeType,
  });
}

export async function fetchUnacknowledgedIdentityChanges(
  observerUserId: string,
  peerUserId?: string,
): Promise<IdentityChangeEvent[]> {
  let q = supabase
    .from('user_identity_change_events' as any)
    .select('id, peer_user_id, previous_fingerprint, new_fingerprint, acknowledged, observed_at, change_type')
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
    changeType: (r.change_type as IdentityChangeType) ?? 'identity_rotation',
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
