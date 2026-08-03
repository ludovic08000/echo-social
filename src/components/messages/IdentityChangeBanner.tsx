// Lot A4 — Identity-change banner (Signal-style "safety number changed").
//
// Subscribes to unacknowledged identity-change events for the current user
// and a given peer, and shows a banner on top of the chat with an "I trust"
// action that acknowledges the change.

import { useEffect, useState, useCallback } from 'react';
import { ShieldAlert, ShieldCheck, Check } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  fetchUnacknowledgedIdentityChanges,
  acknowledgeAllForPeer,
  type IdentityChangeEvent,
} from '@/lib/crypto/identityChangeLedger';
import {
  invalidateFingerprintCheckCache,
  saveKnownFingerprint,
  saveKnownFingerprintServer,
} from '@/lib/crypto/fingerprintTracker';

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
    void load();
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
        () => void load(),
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [observerUserId, peerUserId, load]);

  if (!events.length) return null;
  const latest = events[0];
  const previewPrev = latest.previousFingerprint ? latest.previousFingerprint.slice(0, 12) : '—';
  const previewNew = latest.newFingerprint.slice(0, 12);
  const isRecovery = latest.changeType === 'recovery_restore';

  const acknowledgeIdentityChange = async () => {
    if (!observerUserId || !peerUserId) return;
    setBusy(true);
    try {
      // The server trust record is the cross-device authority. Commit it first;
      // do not clear the warning or enable the route after a failed write.
      const persisted = await saveKnownFingerprintServer(
        peerUserId,
        latest.newFingerprint,
        true,
      );
      if (!persisted) throw new Error('FINGERPRINT_ACK_PERSISTENCE_FAILED');

      saveKnownFingerprint(observerUserId, peerUserId, latest.newFingerprint);
      invalidateFingerprintCheckCache(peerUserId);
      await acknowledgeAllForPeer(observerUserId, peerUserId);
      setEvents([]);

      try {
        window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
          detail: {
            peerUserId,
            reason: 'fingerprint_acknowledged_by_user',
          },
        }));
      } catch {
        // Event delivery is optional outside browser runtimes.
      }
    } catch (error) {
      console.warn('[A4][banner] acknowledgement failed', error);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'mx-2 mt-2 rounded-2xl border backdrop-blur',
        'px-3 py-2 text-sm shadow-sm flex items-start gap-2',
        isRecovery
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-100'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-100',
        className,
      )}
      role="alert"
    >
      {isRecovery ? (
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-sky-300" aria-hidden />
      ) : (
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" aria-hidden />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {isRecovery
            ? 'Ce contact a restauré son compte'
            : 'Le numéro de sécurité a changé'}
        </div>
        <div className="text-xs opacity-80 truncate">
          {isRecovery
            ? 'Re-vérifiez le numéro de sécurité pour reprendre les échanges en confiance.'
            : <>{previewPrev} → <span className="font-mono">{previewNew}</span>. Vérifiez avant d'envoyer un message sensible.</>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onVerifyClick && (
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-7 px-2', isRecovery ? 'text-sky-100 hover:bg-sky-500/20' : 'text-amber-100 hover:bg-amber-500/20')}
            onClick={onVerifyClick}
          >
            Vérifier
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className={cn('h-7 px-2', isRecovery ? 'text-sky-100 hover:bg-sky-500/20' : 'text-amber-100 hover:bg-amber-500/20')}
          disabled={busy || !observerUserId || !peerUserId}
          onClick={() => void acknowledgeIdentityChange()}
        >
          <Check className="h-3.5 w-3.5 mr-1" /> Je fais confiance
        </Button>
      </div>
    </div>
  );
}
