import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  hasPendingIdentityRotation,
  recoverPendingIdentityRotation,
  rotateAccountIdentity,
} from '@/lib/crypto/identityRotation';
import { hasRemoteIdentityRotationRecovery } from '@/lib/crypto/identityRotationRecovery';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const CONFIRMATION = 'RÉVOQUER LES AUTRES APPAREILS';

function messageForError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes('UNLOCKED_BACKUP_REQUIRED') || code.includes('MASTER_KEY_REQUIRED')) {
    return 'Déverrouillez d’abord la sauvegarde chiffrée de la messagerie.';
  }
  if (code.includes('APPROVER_NOT_TRUSTED')) {
    return 'La rotation doit être lancée depuis un appareil actif et déjà approuvé.';
  }
  if (code.includes('DEVICE_PRIVATE_KEY_REQUIRED')) {
    return 'La clé privée de cet appareil est indisponible. Réparez ou ré-enrôlez cet appareil.';
  }
  if (code.includes('LOCAL_SERVER_IDENTITY_MISMATCH')) {
    return 'L’identité locale ne correspond pas à celle du serveur. Une restauration est requise.';
  }
  if (code.includes('COMMITTED_LOCAL_PROMOTION_PENDING')) {
    return 'La rotation serveur est validée. La finalisation locale doit être reprise.';
  }
  return 'Rotation impossible. Aucune identité existante n’a été remplacée silencieusement.';
}

export function IdentityRotationPanel() {
  const [confirmation, setConfirmation] = useState('');
  const [rotating, setRotating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const confirmed = confirmation === CONFIRMATION;

  const refreshPending = async () => {
    const [localPending, remotePending] = await Promise.all([
      hasPendingIdentityRotation().catch(() => false),
      hasRemoteIdentityRotationRecovery().catch(() => false),
    ]);
    setPending(localPending || remotePending);
  };

  useEffect(() => {
    void refreshPending();
  }, []);

  const handleRotate = async () => {
    if (!confirmed || rotating) return;
    setRotating(true);
    try {
      const result = await rotateAccountIdentity('manual_rotation');
      setConfirmation('');
      setPending(false);
      setDialogOpen(false);
      toast.success(`Identité E2EE renouvelée · epoch ${result.identityEpoch}`);
    } catch (error) {
      await refreshPending();
      toast.error(messageForError(error));
    } finally {
      setRotating(false);
    }
  };

  const handleRecover = async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      const recovered = await recoverPendingIdentityRotation();
      if (recovered) {
        setPending(false);
        toast.success('Rotation E2EE finalisée et sauvegardée.');
      } else {
        await refreshPending();
        toast.error('Aucune rotation validée ne peut être finalisée actuellement.');
      }
    } catch (error) {
      await refreshPending();
      toast.error(messageForError(error));
    } finally {
      setRecovering(false);
    }
  };

  return (
    <section className="space-y-3 border-t border-border/50 pt-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <KeyRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Renouveler l’identité de chiffrement</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Crée une nouvelle paire X25519/Ed25519, change votre numéro de sécurité
            et révoque immédiatement tous les autres appareils. Ils devront être
            approuvés de nouveau.
          </p>
        </div>
      </div>

      {pending && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <RotateCcw className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Finalisation interrompue</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Le serveur peut déjà avoir validé la nouvelle identité. Reprenez la
                sauvegarde, les nouvelles pré-clés et la fermeture des anciennes sessions.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3 rounded-xl"
                disabled={recovering || rotating}
                onClick={() => void handleRecover()}
              >
                {recovering
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <RotateCcw className="mr-2 h-4 w-4" />}
                Reprendre la finalisation
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!rotating) setDialogOpen(open);
          if (!open) setConfirmation('');
        }}
      >
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="destructive"
            className="w-full rounded-xl"
            disabled={rotating || recovering || pending}
          >
            {rotating
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <ShieldAlert className="mr-2 h-4 w-4" />}
            Renouveler les clés principales
          </Button>
        </AlertDialogTrigger>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Rotation complète de l’identité E2EE
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                Cette opération remplace vos clés principales de chiffrement et de
                signature. Les contacts verront un changement de numéro de sécurité.
              </span>
              <span className="block font-medium text-foreground">
                Tous les autres appareils seront révoqués immédiatement. Cet appareil
                doit être approuvé et la sauvegarde chiffrée doit être déverrouillée.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <label htmlFor="identity-rotation-confirmation" className="text-xs font-medium">
              Saisissez exactement : <span className="font-mono">{CONFIRMATION}</span>
            </label>
            <Input
              id="identity-rotation-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={rotating}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotating}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={!confirmed || rotating}
              onClick={(event) => {
                event.preventDefault();
                void handleRotate();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {rotating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmer la rotation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
