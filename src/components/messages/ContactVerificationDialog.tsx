import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ShieldAlert, ShieldCheck, Fingerprint, XCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { fetchPeerPublicKeys } from '@/lib/crypto/peerKeyCache';
import { acceptPeerFingerprint } from '@/lib/crypto/fingerprintTracker';
import { deriveAegisSafetyNumber } from '@/lib/crypto/safetyNumber';

interface VerificationRequest {
  conversationId?: string;
  localId?: string;
  reason?: string;
  receivedAt: number;
}

interface ResolvedVerification {
  currentUserId: string;
  peerUserId: string;
  myFingerprint: string;
  peerFingerprint: string;
  safetyNumber: string;
}

export function ContactVerificationDialog() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [resolved, setResolved] = useState<ResolvedVerification | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onRequired = (event: Event) => {
      const detail = (event as CustomEvent<Partial<VerificationRequest>>).detail || {};
      setResolved(null);
      setRequest({
        conversationId: detail.conversationId,
        localId: detail.localId,
        reason: detail.reason,
        receivedAt: Date.now(),
      });
    };
    window.addEventListener('forsure:e2ee-contact-verification-required', onRequired as EventListener);
    return () => window.removeEventListener('forsure:e2ee-contact-verification-required', onRequired as EventListener);
  }, []);

  useEffect(() => {
    if (!request?.conversationId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('NOT_AUTHENTICATED');
      const { data: participants, error } = await supabase
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', request.conversationId!);
      if (error) throw error;
      const peerUserId = participants
        ?.map((entry) => entry.user_id)
        .find((id): id is string => Boolean(id) && id !== user.id);
      if (!peerUserId) throw new Error('PEER_NOT_FOUND');
      const [mine, peer] = await Promise.all([
        getOrCreateIdentityKeys(user.id),
        fetchPeerPublicKeys(peerUserId, { forceRefresh: true }),
      ]);
      if (!peer) throw new Error('PEER_IDENTITY_UNAVAILABLE');
      const safetyNumber = await deriveAegisSafetyNumber(mine.fingerprint, peer.fingerprint);
      if (!cancelled) {
        setResolved({
          currentUserId: user.id,
          peerUserId,
          myFingerprint: mine.fingerprint,
          peerFingerprint: peer.fingerprint,
          safetyNumber,
        });
      }
    })().catch((error) => {
      console.error('[E2EE] Contact verification resolution failed', error);
      if (!cancelled) toast.error('Impossible de charger les vraies clés de sécurité.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [request]);

  const formattedSafety = useMemo(() => resolved?.safetyNumber ?? '', [resolved]);
  const close = () => {
    setRequest(null);
    setResolved(null);
  };

  const handleTrust = async () => {
    if (!request || !resolved) return;
    await acceptPeerFingerprint({
      currentUserId: resolved.currentUserId,
      peerUserId: resolved.peerUserId,
      fingerprint: resolved.peerFingerprint,
    });
    window.dispatchEvent(new CustomEvent('forsure:e2ee-contact-verified', {
      detail: {
        conversationId: request.conversationId,
        localId: request.localId,
        peerUserId: resolved.peerUserId,
        fingerprint: resolved.peerFingerprint,
        acceptedAt: Date.now(),
      },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { source: 'contact-verification', conversationId: request.conversationId },
    }));
    toast.success('Empreinte réelle validée. Vous pouvez réessayer l’envoi.');
    close();
  };

  if (!request) return null;

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" />
            <DialogTitle>Vérification de sécurité requise</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>La clé d’identité stable du contact a changé. L’envoi reste bloqué jusqu’à comparaison par un autre canal sûr.</p>
            <p>Ne validez pas uniquement parce que l’application affiche cette fenêtre.</p>
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-muted/40 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Fingerprint className="w-4 h-4" /> Numéro de sécurité dérivé des deux clés
          </div>
          {loading && <Loader2 className="w-5 h-5 animate-spin" />}
          {!loading && resolved && (
            <>
              <div className="font-mono text-sm break-words leading-relaxed select-all">{formattedSafety}</div>
              <p className="text-[10px] text-muted-foreground break-all">Votre empreinte : {resolved.myFingerprint}</p>
              <p className="text-[10px] text-muted-foreground break-all">Empreinte du contact : {resolved.peerFingerprint}</p>
            </>
          )}
          {!loading && !resolved && (
            <p className="text-sm text-destructive">Validation indisponible : aucune empreinte réelle n’a été chargée.</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={close}>
            <XCircle className="w-4 h-4 mr-2" /> Annuler
          </Button>
          <Button onClick={() => void handleTrust()} disabled={!resolved || loading}>
            <ShieldCheck className="w-4 h-4 mr-2" /> J’ai comparé les deux valeurs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Legacy callers must not bypass the fingerprint tracker. */
export function hasTrustedContactChange(): boolean {
  return false;
}
