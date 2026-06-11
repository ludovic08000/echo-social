/**
 * Recovery markers — published by a user right after a successful key
 * restore so peers can classify an observed fingerprint rotation as a
 * benign recovery (TOFU recovery-aware), not a potential MITM.
 *
 * Markers only carry the new fingerprint hash + timestamp, no plaintext.
 * Server-side trigger purges entries older than 7 days.
 */

import { supabase } from '@/integrations/supabase/client';

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h lookback for peer detection

export async function publishRecoveryMarker(params: {
  userId: string;
  fingerprint: string;
  reason: string;
}): Promise<void> {
  if (!params.userId || !params.fingerprint) return;
  try {
    await supabase.from('user_recovery_events' as any).insert({
      user_id: params.userId,
      fingerprint: params.fingerprint,
      reason: params.reason,
    });
  } catch (e) {
    console.warn('[A4][recovery-marker] publish failed', e);
  }
}

/**
 * Returns true if `peerUserId` published a recovery marker within the last
 * 24h whose fingerprint matches `newFingerprint`.
 */
export async function peerHasRecentRecoveryMarker(
  peerUserId: string,
  newFingerprint: string,
): Promise<boolean> {
  if (!peerUserId || !newFingerprint) return false;
  try {
    const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
    const { data } = await supabase
      .from('user_recovery_events' as any)
      .select('id')
      .eq('user_id', peerUserId)
      .eq('fingerprint', newFingerprint)
      .gte('occurred_at', since)
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}
