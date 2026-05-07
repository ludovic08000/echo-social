// Lot A4 — Identity-change banner (Signal-style "safety number changed").
//
// Subscribes to unacknowledged identity-change events for the current user
// and a given peer, and shows a banner on top of the chat with an "I trust"
// action that acknowledges the change.

import { useEffect, useState, useCallback } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  fetchUnacknowledgedIdentityChanges,
  acknowledgeAllForPeer,
  type IdentityChangeEvent,
} from '@/lib/crypto/identityChangeLedger';

interface Props {
  observerUserId: string | null;
  peerUserId: string | null;
  onVerifyClick?: () => void;
  className?: string;
}

export function IdentityChangeBanner({ observerUserId, peerUserId, onVerifyClick, className }: Props) {
  const [events, setEvents] = useState<IdentityChangeEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!observerUserId || !peerUserId) return;
    try {
      const list = await fetchUnacknowledgedIdentityChanges(observerUserId, peerUserId);
      setEvents(list);
    } catch (e) {
      console.warn('[A4][banner] load failed', e);
    }
  }, [observerUserId, peerUserId]);

  useEffect(() => {
    load();
    if (!observerUserId) return;
    const ch = supabase
      .channel(`identity-change-${observerUserId}-${peerUserId || 'all'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_identity_change_events',
          filter: `observer_user_id=eq.${observerUserId}`,
        },
        () => load(),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [observerUserId, peerUserId, load]);

  if (!events.length) return null;
  const latest = events[0];
  const previewPrev = latest.previousFingerprint ? latest.previousFingerprint.slice(0, 12) : '—';
  const previewNew = latest.newFingerprint.slice(0, 12);

  return (
    <div
      className={cn(
        'mx-2 mt-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 backdrop-blur',
        'px-3 py-2 text-sm text-amber-100 shadow-sm flex items-start gap-2',
        className,
      )}
      role="alert"
    >
      <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-medium">Le numéro de sécurité a changé</div>
        <div className="text-xs opacity-80 truncate">
          {previewPrev} → <span className="font-mono">{previewNew}</span>. Vérifiez avant d'envoyer un message sensible.
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onVerifyClick && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-amber-100 hover:bg-amber-500/20" onClick={onVerifyClick}>
            Vérifier
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-amber-100 hover:bg-amber-500/20"
          disabled={busy || !observerUserId || !peerUserId}
          onClick={async () => {
            if (!observerUserId || !peerUserId) return;
            setBusy(true);
            try {
              await acknowledgeAllForPeer(observerUserId, peerUserId);
              setEvents([]);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Check className="h-3.5 w-3.5 mr-1" /> Je fais confiance
        </Button>
      </div>
    </div>
  );
}
