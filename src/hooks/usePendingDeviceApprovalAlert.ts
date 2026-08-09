/**
 * Alerte "appareil en attente d'approbation".
 *
 * Les RPC `pending_device_approvals` / `has_approved_device` n'existent pas en
 * base: la lecture passe donc par `user_devices` (RLS propriétaire). Realtime
 * porte la réactivité, un rafraîchissement lent sert uniquement de filet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { peekCurrentDeviceId } from '@/lib/messaging/currentDevice';

export interface PendingDeviceApproval {
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  requestedAt: string | null;
}

/** Filet de sécurité lent: Realtime reste la source de réactivité. */
const FALLBACK_REFRESH_MS = 120_000;

export function usePendingDeviceApprovalAlert() {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDeviceApproval[]>([]);
  const [hasApprovedDevice, setHasApprovedDevice] = useState(false);
  const notifiedRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!user?.id) {
      setPending([]);
      setHasApprovedDevice(false);
      return;
    }

    const { data, error } = await supabase
      .from('user_devices')
      .select('device_id,device_name,platform,approval_status,approval_requested_at,is_active,revoked_at')
      .eq('user_id', user.id);
    if (error || !data) return;

    const currentDeviceId = peekCurrentDeviceId();
    const rows = data as Array<Record<string, unknown>>;

    setHasApprovedDevice(rows.some((row) => (
      row.approval_status === 'approved' && row.is_active === true && !row.revoked_at
    )));

    const nextPending = rows
      .filter((row) => row.approval_status === 'pending' && !row.revoked_at)
      .filter((row) => row.device_id !== currentDeviceId)
      .map((row) => ({
        deviceId: String(row.device_id),
        deviceName: (row.device_name as string | null) ?? null,
        platform: (row.platform as string | null) ?? null,
        requestedAt: (row.approval_requested_at as string | null) ?? null,
      }));

    setPending(nextPending);

    for (const device of nextPending) {
      if (notifiedRef.current.has(device.deviceId)) continue;
      notifiedRef.current.add(device.deviceId);
      toast.warning('Nouvel appareil en attente d’approbation', {
        description: 'Vérifiez son empreinte dans Réglages → Appareils avant de l’autoriser.',
      });
    }
    const active = new Set(nextPending.map((device) => device.deviceId));
    for (const deviceId of notifiedRef.current) {
      if (!active.has(deviceId)) notifiedRef.current.delete(deviceId);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    void refresh();

    const channel = supabase
      .channel(`pending-device-approval:${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_devices', filter: `user_id=eq.${user.id}` },
        () => void refresh(),
      )
      .subscribe();

    const timer = window.setInterval(() => void refresh(), FALLBACK_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [refresh, user?.id]);

  return { pendingApprovals: pending, hasApprovedDevice, refresh };
}
