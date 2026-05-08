import { useState, useEffect } from 'react';
import { Hash, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import {
  setupBackupPin,
  hasBackupPin,
  deleteBackupPin,
  hasLocalKeys,
} from '@/lib/crypto/accountKeyBackup';
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

/**
 * L5 — Backup PIN setup UI (WhatsApp-style 6-digit PIN).
 * Lives in Settings → Security → Coffre E2EE.
 */
export function BackupPinSection() {
  const { user } = useAuth();
  const [hasPin, setHasPin] = useState(false);
  const [hasLocal, setHasLocal] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    hasBackupPin(user.id).then(setHasPin);
    hasLocalKeys().then(setHasLocal);
  }, [user?.id]);

  const handleSetup = async () => {
    if (!user?.id) return;
    if (!/^\d{6}$/.test(pin)) {
      toast.error('Le PIN doit faire 6 chiffres');
      return;
    }
    if (pin !== confirm) {
      toast.error('Les deux PIN ne correspondent pas');
      return;
    }
    setBusy(true);
    try {
      const result = await setupBackupPin(pin, user.id);
      if (result === 'ok') {
        toast.success('PIN de sauvegarde configuré');
        setHasPin(true);
        setPin(''); setConfirm(''); setShow(false);
      } else if (result === 'no_master_key') {
        toast.error('Reconnecte-toi avec ton mot de passe d\'abord pour activer ce PIN');
      } else if (result === 'invalid_pin') {
        toast.error('PIN invalide');
      } else {
        toast.error('Échec de la configuration du PIN');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      const ok = await deleteBackupPin(user.id);
      if (ok) {
        toast.success('PIN de sauvegarde supprimé');
        setHasPin(false);
      } else {
        toast.error('Échec de la suppression');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Hash className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Sauvegarde par code PIN</span>
        {hasPin && (
          <span className="ml-auto text-[10px] flex items-center gap-1 text-green-500">
            <ShieldCheck className="h-3 w-3" /> Active
          </span>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground leading-snug">
        Style WhatsApp. Un PIN à 6 chiffres déverrouille tes messages si tu vides le cache du navigateur.
        Limité à 10 essais par 24 h côté serveur. Le PIN ne quitte jamais ton appareil.
      </p>

      {hasPin ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => setShow(true)}
              disabled={busy}
            >
              Changer le PIN
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="text-xs text-destructive" disabled={busy}>
                  <Trash2 className="h-3 w-3 mr-1" /> Supprimer
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Supprimer la sauvegarde par PIN ?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Tu pourras toujours restaurer tes messages avec ton mot de passe ou ta clé de récupération.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>Supprimer</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          className="w-full text-xs"
          onClick={() => setShow(true)}
          disabled={busy || !hasLocal}
        >
          <Hash className="h-3 w-3 mr-1" /> Configurer un PIN à 6 chiffres
        </Button>
      )}

      {!hasLocal && !hasPin && (
        <p className="text-[10px] text-yellow-500">
          Reconnecte-toi avec ton mot de passe pour activer la sauvegarde par PIN.
        </p>
      )}

      {show && (
        <div className="space-y-2 pt-2 border-t border-primary/20">
          <div className="space-y-1">
            <Label htmlFor="new-pin" className="text-xs">Nouveau PIN (6 chiffres)</Label>
            <Input
              id="new-pin"
              type="tel"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="••••••"
              className="text-center tracking-[0.5em] text-base"
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="confirm-pin" className="text-xs">Confirmer</Label>
            <Input
              id="confirm-pin"
              type="tel"
              inputMode="numeric"
              maxLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="••••••"
              className="text-center tracking-[0.5em] text-base"
              disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && pin.length === 6 && confirm.length === 6) handleSetup(); }}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="flex-1 text-xs" onClick={() => { setShow(false); setPin(''); setConfirm(''); }} disabled={busy}>
              Annuler
            </Button>
            <Button size="sm" className="flex-1 text-xs" onClick={handleSetup} disabled={busy || pin.length !== 6 || confirm.length !== 6}>
              {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Enregistrer
            </Button>
          </div>
          <p className="text-[10px] text-yellow-500 leading-snug">
            ⚠️ Si tu oublies ce PIN, tu devras passer par ton mot de passe ou ta clé de récupération. Aucune réinitialisation possible côté serveur.
          </p>
        </div>
      )}
    </div>
  );
}
