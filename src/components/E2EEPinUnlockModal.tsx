import { useEffect, useState } from 'react';
import { KeyRound, LockKeyhole } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MessagingPinGate } from '@/components/MessagingPinGate';
import { useAuth } from '@/lib/auth';

const PIN_UNLOCK_REQUIRED_MESSAGE = 'Déverrouillage requis pour restaurer vos messages chiffrés';

interface PinUnlockRequestDetail {
  userId?: string;
  reason?: string;
  message?: string;
}

export function E2EEPinUnlockModal() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [request, setRequest] = useState<PinUnlockRequestDetail | null>(null);

  useEffect(() => {
    if (!userId) {
      setRequest(null);
      return;
    }

    const storageKey = `forsure:e2ee-pin-unlock-required:${userId}`;
    const openFromDetail = (detail?: PinUnlockRequestDetail | null) => {
      if (detail?.userId && detail.userId !== userId) return;
      setRequest({
        userId,
        reason: detail?.reason,
        message: detail?.message || PIN_UNLOCK_REQUIRED_MESSAGE,
      });
    };

    try {
      const pending = sessionStorage.getItem(storageKey);
      if (pending) {
        const parsed = JSON.parse(pending);
        openFromDetail(parsed?.detail ?? null);
      }
    } catch {}

    const onPinRequired = (event: Event) => {
      openFromDetail((event as CustomEvent<PinUnlockRequestDetail>).detail);
    };
    const onUnlocked = () => {
      setRequest(null);
      try { sessionStorage.removeItem(storageKey); } catch {}
    };

    window.addEventListener('forsure:e2ee-pin-unlock-required', onPinRequired);
    window.addEventListener('forsure-keys-unlocked', onUnlocked);
    window.addEventListener('forsure:e2ee-resync-complete', onUnlocked);
    return () => {
      window.removeEventListener('forsure:e2ee-pin-unlock-required', onPinRequired);
      window.removeEventListener('forsure-keys-unlocked', onUnlocked);
      window.removeEventListener('forsure:e2ee-resync-complete', onUnlocked);
    };
  }, [userId]);

  if (!userId) return null;

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) setRequest(null); }}>
      <DialogContent className="max-w-sm rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-2 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <LockKeyhole className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="text-base leading-snug">
            {request?.message || PIN_UNLOCK_REQUIRED_MESSAGE}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Entrez votre PIN pour restaurer localement vos clés E2EE, relancer la récupération des messages, puis resauvegarder cet appareil.
          </DialogDescription>
        </DialogHeader>
        <div className="px-3 pb-4">
          <MessagingPinGate compact>
            <div className="flex items-center justify-center gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3 py-4 text-xs font-medium text-primary">
              <KeyRound className="h-4 w-4" />
              Restauration sécurisée lancée
            </div>
          </MessagingPinGate>
        </div>
      </DialogContent>
    </Dialog>
  );
}
