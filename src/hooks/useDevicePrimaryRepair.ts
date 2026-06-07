/**
 * useDevicePrimaryRepair — reacts to `device_primary_repair_requests` rows
 * inserted by the server-side `trg_handle_primary_device_loss` trigger.
 *
 * Contracts:
 *  - Owner-only: RLS already restricts SELECT to `auth.uid() = user_id`, and
 *    the realtime channel is filtered on the same column. No cross-user leak.
 *  - NEVER auto-promote client-side. Promotion is only done by the DB trigger
 *    (and only when exactly 1 eligible device remains). The hook just reacts.
 *  - A1 trust gate is untouched.
 *
 * Reasons:
 *  - `auto_promoted`           → silent: republish signed device list +
 *                                full post-restore lifecycle (epoch bump,
 *                                SPK/OPK refresh, sender-key resync,
 *                                refanout scan). Resolve immediately.
 *  - `manual_relink_required`  → show modal asking the user to relink /
 *                                approve a device from a trusted one.
 *                                Resolved when the user dismisses after a
 *                                successful manual action.
 *  - `no_eligible_device`      → show modal asking the user to log out and
 *                                log back in (and re-enter PIN if backup
 *                                exists). Resolved on user ack.
 */
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { publishOwnSignedDeviceList } from '@/lib/crypto/signedDeviceList';
import { runPostRestoreLifecycle } from '@/lib/crypto/postRestoreLifecycle';

export type RepairReason = 'auto_promoted' | 'manual_relink_required' | 'no_eligible_device';

export interface DevicePrimaryRepairRequest {
  id: string;
  user_id: string;
  reason: RepairReason;
  candidate_device_ids: string[];
  resolved_at: string | null;
  created_at: string;
}

async function markResolved(id: string): Promise<void> {
  try {
    await (supabase as any).rpc('resolve_device_primary_repair_request', { p_id: id });
  } catch (err) {
    console.warn('[device-primary-repair] resolve RPC failed', err);
  }
}

async function handleAutoPromoted(req: DevicePrimaryRepairRequest, userId: string): Promise<void> {
  console.info('[device-primary-repair] auto_promoted — resyncing silently', {
    candidate: req.candidate_device_ids[0],
  });
  try {
    await publishOwnSignedDeviceList();
  } catch (err) {
    console.warn('[device-primary-repair] publishOwnSignedDeviceList failed', err);
  }
  try {
    await runPostRestoreLifecycle(userId, 'unknown');
  } catch (err) {
    console.warn('[device-primary-repair] runPostRestoreLifecycle failed', err);
  }
  await markResolved(req.id);
}

export function useDevicePrimaryRepair(): {
  pending: DevicePrimaryRepairRequest | null;
  dismiss: () => Promise<void>;
} {
  const { user } = useAuth();
  const [pending, setPending] = useState<DevicePrimaryRepairRequest | null>(null);

  const ingest = useCallback(async (row: DevicePrimaryRepairRequest) => {
    if (!user?.id || row.user_id !== user.id || row.resolved_at) return;

    if (row.reason === 'auto_promoted') {
      await handleAutoPromoted(row, user.id);
      return;
    }
    // Manual reasons surface in the UI.
    setPending(prev => (prev ? prev : row));
  }, [user?.id]);

  // Initial catch-up: any unresolved request created during downtime.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('device_primary_repair_requests')
        .select('id, user_id, reason, candidate_device_ids, resolved_at, created_at')
        .eq('user_id', user.id)
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
        .limit(5);
      if (cancelled || error || !data) return;
      for (const row of data as DevicePrimaryRepairRequest[]) {
        await ingest(row);
        if (cancelled) return;
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id, ingest]);

  // Realtime subscription scoped to the current user.
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`device-primary-repair:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'device_primary_repair_requests',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as DevicePrimaryRepairRequest;
          void ingest(row);
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user?.id, ingest]);

  const dismiss = useCallback(async () => {
    const current = pending;
    if (!current) return;
    await markResolved(current.id);
    setPending(null);
  }, [pending]);

  return { pending, dismiss };
}
