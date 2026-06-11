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
import { ShieldAlert, ShieldCheck, Fingerprint, XCircle } from 'lucide-react';
import { toast } from 'sonner';

interface VerificationRequest {
  conversationId?: string;
  localId?: string;
  reason?: string;
  receivedAt: number;
}

const TRUST_STORE_KEY = 'forsure:e2ee:trusted-contact-changes:v1';

function readTrustStore(): Record<string, { acceptedAt: number; reason?: string }> {
  try {
    const raw = localStorage.getItem(TRUST_STORE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, { acceptedAt: number; reason?: string }>;
  } catch {
    return {};
  }
}

function writeTrustStore(store: Record<string, { acceptedAt: number; reason?: string }>) {
  try {
    localStorage.setItem(TRUST_STORE_KEY, JSON.stringify(store));
  } catch {}
}

function trustKey(req: VerificationRequest): string {
  return req.conversationId || 'global';
}

/**
 * ContactVerificationDialog
 *
 * Handles the Signal/WhatsApp-style safety-key warning emitted by the queue
 * when encryption refuses to continue because the peer identity/fingerprint
 * changed. This component deliberately does not auto-trust anything: it gives
 * the user a visible stop screen and only resumes retries after a manual
 * confirmation.
 */
export function ContactVerificationDialog() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);

  useEffect(() => {
    const onRequired = (event: Event) => {
      const detail = (event as CustomEvent<Partial<VerificationRequest>>).detail || {};
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

  const safetyNumber = useMemo(() => {
    if (!request) return '';
    const seed = `${request.conversationId || ''}:${request.reason || ''}`;
    let acc = 0;
    for (let i = 0; i < seed.length; i++) acc = (acc * 31 + seed.charCodeAt(i)) >>> 0;
    return Array.from({ length: 6 }, (_, i) => String((acc + i * 7919) % 100000).padStart(5, '0')).join(' ');
  }, [request]);

  const close = () => setRequest(null);

  const handleTrust = () => {
    if (!request) return;
    const store = readTrustStore();
    store[trustKey(request)] = {
      acceptedAt: Date.now(),
      reason: request.reason,
    };
    writeTrustStore(store);

    try {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-contact-verified', {
        detail: {
          conversationId: request.conversationId,
          localId: request.localId,
          acceptedAt: Date.now(),
        },
      }));
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
        detail: { source: 'contact-verification', conversationId: request.conversationId },
      }));
    } catch {}

    toast.success('Identité validée. Vous pouvez réessayer l’envoi.');
    close();
  };

  if (!request) return null;

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" />
            <DialogTitle>Vérification de sécurité requise</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>
              La clé de sécurité de ce contact a changé. Par sécurité, l’envoi est bloqué
              jusqu’à validation manuelle.
            </p>
            <p>
              Cela peut arriver après une réinstallation, un nouveau téléphone, une restauration
              de clés ou une rotation d’appareil. Ne validez que si vous reconnaissez ce changement.
            </p>
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-muted/40 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Fingerprint className="w-4 h-4" />
            Numéro de sécurité local
          </div>
          <div className="font-mono text-sm break-words leading-relaxed select-all">
            {safetyNumber}
          </div>
          {request.reason && (
            <p className="text-xs text-muted-foreground break-words">
              Diagnostic : {request.reason}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={close}>
            <XCircle className="w-4 h-4 mr-2" />
            Annuler
          </Button>
          <Button onClick={handleTrust}>
            <ShieldCheck className="w-4 h-4 mr-2" />
            Marquer comme fiable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function hasTrustedContactChange(conversationId?: string): boolean {
  if (!conversationId) return false;
  const store = readTrustStore();
  return !!store[conversationId];
}
