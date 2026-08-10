import { useEffect, useState } from 'react';
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePendingDeviceApprovalRequests } from '@/hooks/usePendingDeviceApprovalRequests';

/**
 * Modale globale affichée UNIQUEMENT sur un appareil déjà prêt/approuvé,
 * pour un AUTRE appareil en attente. L'auto-approbation reste impossible.
 */
export function PendingDeviceApprovalDialog() {
  const { requests, canDecide, deciding, error, decide } = usePendingDeviceApprovalRequests();
  const [dismissed, setDismissed] = useState<string[]>([]);

  const request = requests.find((item) => !dismissed.includes(item.deviceId)) ?? null;
  const open = canDecide && !!request;

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  if (!open || !request) return null;

  const busy = deciding === request.deviceId;

  const handle = async (decision: 'approve' | 'reject') => {
    const ok = await decide(request.deviceId, decision);
    if (ok) toast.success(decision === 'approve' ? 'Appareil approuvé' : 'Appareil refusé');
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) setDismissed((c) => [...c, request.deviceId]); }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10">
            <ShieldQuestion className="h-5 w-5 text-amber-600" />
          </div>
          <DialogTitle>Nouvel appareil en attente</DialogTitle>
          <DialogDescription>
            Un appareil demande l’accès à votre messagerie chiffrée. Comparez l’empreinte affichée sur les deux écrans avant d’approuver.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
          <p className="text-sm font-semibold">{request.deviceName}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {request.platform ?? 'web'} · {request.deviceId.slice(0, 16)}…
          </p>
        </div>

        {request.fingerprintLines.length > 0 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Empreinte cryptographique</p>
            <div className="mt-1 font-mono text-xs leading-relaxed tracking-wider">
              {request.fingerprintLines.map((line) => <span key={line} className="block">{line}</span>)}
            </div>
          </div>
        )}

        <DialogFooter className="grid grid-cols-2 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            className="rounded-xl"
            disabled={busy}
            onClick={() => void handle('reject')}
          >
            <X className="mr-1.5 h-4 w-4" />
            Refuser
          </Button>
          <Button
            className="rounded-xl"
            disabled={busy}
            onClick={() => void handle('approve')}
          >
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
            Approuver
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
