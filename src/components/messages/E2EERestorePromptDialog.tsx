import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  initAccountKeySync,
  hasLocalKeys,
} from '@/lib/crypto/accountKeyBackup';
import { restoreAegisRecoveryVault } from '@/lib/crypto/aegisRecoveryVault';
import {
  acquireRecoveryDialog,
  releaseRecoveryDialog,
} from '@/lib/crypto/recoveryDialogCoordinator';
import { inspectAccountCryptoState } from '@/lib/crypto/accountCryptoState';
import { IdentityResetScreen } from '@/components/messaging/IdentityRecoveryGate';
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, hydrateDeviceId } from '@/lib/messaging/currentDevice';

const DIALOG_OWNER = 'e2ee-restore-prompt';
const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

type CurrentDeviceApprovalState = 'approved' | 'pending' | 'unavailable';
type RestoreRequestDetail = {
  allowPendingDeviceRecovery?: boolean;
  source?: string;
  reason?: string;
  deviceId?: string;
};

async function currentDeviceApprovalState(userId: string): Promise<CurrentDeviceApprovalState> {
  const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) return 'unavailable';

  const { data, error } = await supabase
    .from('user_devices')
    .select('approval_status,is_active,revoked_at,crypto_invalid_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error || !data || data.revoked_at || data.crypto_invalid_at) return 'unavailable';
  if (data.approval_status === 'approved' && data.is_active === true) return 'approved';
  if (data.approval_status === 'pending' && data.is_active === false) return 'pending';
  return 'unavailable';
}

export function E2EERestorePromptDialog() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [tab, setTab] = useState<'password' | 'recovery'>('password');
  const [mode, setMode] = useState<'restore' | 'reset'>('restore');
  const [pendingDeviceRecovery, setPendingDeviceRecovery] = useState(false);

  useEffect(() => () => releaseRecoveryDialog(DIALOG_OWNER), []);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    const promptIfIdentityMissing = async (rawDetail: unknown) => {
      const detail = (rawDetail && typeof rawDetail === 'object'
        ? rawDetail
        : {}) as RestoreRequestDetail;
      const approvalState = await currentDeviceApprovalState(user.id);
      const pendingRecoveryAllowed =
        approvalState === 'pending' && detail.allowPendingDeviceRecovery === true;

      if (approvalState !== 'approved' && !pendingRecoveryAllowed) return;

      try {
        if (await hasLocalKeys(user.id)) {
          if (pendingRecoveryAllowed) {
            window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
              detail: { status: 'pending_device_identity_already_local' },
            }));
          }
          return;
        }
      } catch {
        // Une inspection locale en erreur ne doit pas masquer la restauration.
      }
      if (cancelled) return;

      const inspection = await inspectAccountCryptoState(user.id);
      if (cancelled) return;
      if (inspection.state === 'RESTORABLE_IDENTITY') {
        setMode('restore');
      } else if (inspection.state === 'UNRECOVERABLE_SERVER_IDENTITY') {
        if (pendingRecoveryAllowed) {
          toast.error(
            'Aucune sauvegarde ne permet de prouver cette identité. Une réinitialisation cryptographique séparée est nécessaire.',
          );
          return;
        }
        setMode('reset');
      } else {
        return;
      }

      if (!acquireRecoveryDialog(DIALOG_OWNER)) return;
      setPendingDeviceRecovery(pendingRecoveryAllowed);
      console.warn('[E2EERestore] prompting identity recovery', {
        state: inspection.state,
        approvalState,
        pendingRecoveryAllowed,
        detail,
      });
      setOpen(true);
    };

    const onNeeded = async (event: Event) => {
      await promptIfIdentityMissing((event as CustomEvent).detail || {});
    };
    window.addEventListener('forsure:e2ee-restore-needed', onNeeded as EventListener);

    // Automatic recovery prompts remain restricted to an already approved
    // device. A pending device enters recovery only after the user explicitly
    // presses “Récupérer ce compte” in the global approval gate.
    void (async () => {
      const { data, error } = await supabase
        .from('user_public_keys')
        .select('fingerprint')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      if (!error && data?.fingerprint) {
        await promptIfIdentityMissing({ reason: 'approved_device_without_local_identity' });
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('forsure:e2ee-restore-needed', onNeeded as EventListener);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!open) return;
    const onRestored = () => {
      setOpen(false);
      releaseRecoveryDialog(DIALOG_OWNER);
      setPassword('');
      setRecoveryKey('');
      toast.success(
        pendingDeviceRecovery
          ? 'Identité restaurée — approbation cryptographique en cours'
          : 'Messages déverrouillés',
      );
    };
    window.addEventListener('forsure-keys-restored', onRestored);
    return () => window.removeEventListener('forsure-keys-restored', onRestored);
  }, [open, pendingDeviceRecovery]);

  const finish = (origin: string) => {
    setOpen(false);
    releaseRecoveryDialog(DIALOG_OWNER);
    setPassword('');
    setRecoveryKey('');
    window.dispatchEvent(new CustomEvent('forsure-keys-unlocked', {
      detail: { origin, pendingDeviceRecovery },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { origin, pendingDeviceRecovery },
    }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: origin, pendingDeviceRecovery },
    }));
    toast.success(
      pendingDeviceRecovery
        ? 'Identité restaurée — validation du nouvel appareil'
        : 'Vos messages sont à nouveau déchiffrés',
    );
  };

  const handlePassword = async () => {
    if (!user?.id || !password) return;
    setBusy(true);
    try {
      const status = await initAccountKeySync(password, user.id);
      if (status === 'restored' || status === 'local_ok') {
        finish('password_restore');
      } else if (status === 'no_backup') {
        if (pendingDeviceRecovery) {
          toast.error('Aucune sauvegarde de l’identité existante n’a été trouvée.');
        } else {
          setMode('reset');
          toast.error('Aucune sauvegarde trouvée : réinitialisation nécessaire');
        }
      } else {
        toast.error('Mot de passe incorrect ou sauvegarde illisible');
      }
    } catch (error) {
      console.error('[E2EERestore] password restore failed', error);
      toast.error('Échec de la restauration');
    } finally {
      setBusy(false);
    }
  };

  const handleRecovery = async () => {
    if (!user?.id || !recoveryKey.trim()) return;
    setBusy(true);
    try {
      const result = await restoreAegisRecoveryVault(user.id, recoveryKey.trim());
      if (result.status === 'restored' || result.status === 'already_present') {
        finish('recovery_restore');
      } else if (result.status === 'conflict') {
        toast.error('Conflit d’identité : les clés locales ont été conservées');
      } else if (result.status === 'not_found') {
        toast.error('Aucun coffre de récupération trouvé');
      } else {
        toast.error('Clé de récupération invalide ou coffre illisible');
      }
    } catch (error) {
      console.error('[E2EERestore] recovery restore failed', error);
      toast.error('Échec de la restauration');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'reset') {
    return (
      <Dialog open={open} onOpenChange={(value) => {
        setOpen(value);
        if (!value) releaseRecoveryDialog(DIALOG_OWNER);
      }}>
        <DialogContent className="z-[140] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="sr-only">Réinitialiser votre identité sécurisée</DialogTitle>
            <DialogDescription className="sr-only">
              Aucune sauvegarde restaurable n’existe pour ce compte.
            </DialogDescription>
          </DialogHeader>
          <IdentityResetScreen
            onSuccess={() => finish('identity_reset')}
            onRetryRestore={() => setMode('restore')}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(value) => {
      if (busy) return;
      setOpen(value);
      if (!value) releaseRecoveryDialog(DIALOG_OWNER);
    }}>
      <DialogContent className="z-[140] sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <DialogTitle>
              {pendingDeviceRecovery
                ? 'Récupérer ce compte sur cet appareil'
                : 'Restaurer vos messages chiffrés'}
            </DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            {pendingDeviceRecovery ? (
              <>
                <p>
                  Aucun autre appareil approuvé n’est nécessaire si tu peux restaurer l’identité
                  chiffrée permanente de ce compte.
                </p>
                <p>
                  Après restauration, cette identité signera la clé publique propre à cet appareil.
                </p>
              </>
            ) : (
              <>
                <p>
                  Cet appareil est approuvé, mais il doit récupérer l’identité chiffrée commune au
                  compte avant d’accéder aux conversations.
                </p>
                <p>
                  Les clés propres à chaque appareil restent différentes.
                </p>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="password">
              <Lock className="w-4 h-4 mr-1" /> Mot de passe
            </TabsTrigger>
            <TabsTrigger value="recovery">
              <KeyRound className="w-4 h-4 mr-1" /> Clé
            </TabsTrigger>
          </TabsList>

          <TabsContent value="password" className="space-y-3 pt-3">
            <Label htmlFor="restore-password">Mot de passe du compte</Label>
            <Input
              id="restore-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              disabled={busy}
              onKeyDown={(event) => { if (event.key === 'Enter') void handlePassword(); }}
            />
            <Button onClick={handlePassword} disabled={busy || !password} className="w-full">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Déverrouiller
            </Button>
          </TabsContent>

          <TabsContent value="recovery" className="space-y-3 pt-3">
            <Label htmlFor="restore-recovery">Clé de récupération</Label>
            <Input
              id="restore-recovery"
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX-…"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleRecovery(); }}
            />
            <p className="text-xs text-muted-foreground">
              La clé reste locale. Une rotation invalide immédiatement l’ancienne génération.
            </p>
            <Button onClick={handleRecovery} disabled={busy || !recoveryKey.trim()} className="w-full">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Restaurer avec la clé
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter className="text-xs text-muted-foreground">
          Aucune clé privée ni clé de récupération n’est envoyée en clair.
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
