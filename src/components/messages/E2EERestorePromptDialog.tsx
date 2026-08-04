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
import { supabase } from '@/integrations/supabase/client';

const DIALOG_OWNER = 'e2ee-restore-prompt';

export function E2EERestorePromptDialog() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [tab, setTab] = useState<'password' | 'recovery'>('password');

  useEffect(() => () => releaseRecoveryDialog(DIALOG_OWNER), []);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    const promptIfIdentityMissing = async (detail: unknown) => {
      try {
        if (await hasLocalKeys(user.id)) return;
      } catch {
        // Une inspection locale en erreur ne doit pas masquer la restauration.
      }
      if (cancelled) return;
      // Un seul ecran de recuperation peut etre visible a la fois.
      if (!acquireRecoveryDialog(DIALOG_OWNER)) return;
      console.warn('[E2EERestore] prompting user to restore keys', detail);
      setOpen(true);
    };


    const onNeeded = async (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      await promptIfIdentityMissing(detail);
    };
    window.addEventListener('forsure:e2ee-restore-needed', onNeeded as EventListener);
    // Correction : un evenement emis avant le montage du dialogue ne doit plus
    // laisser l'utilisateur bloque. La continuite serveur est reverifiee ici.
    void (async () => {
      const { data, error } = await supabase
        .from('user_public_keys')
        .select('fingerprint')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      if (!error && data?.fingerprint) {
        await promptIfIdentityMissing({ reason: 'server_identity_without_local_identity' });
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
      toast.success('Messages déverrouillés');
    };
    window.addEventListener('forsure-keys-restored', onRestored);
    return () => window.removeEventListener('forsure-keys-restored', onRestored);
  }, [open]);

  const finish = (origin: string) => {
    setOpen(false);
    releaseRecoveryDialog(DIALOG_OWNER);
    setPassword('');
    setRecoveryKey('');
    window.dispatchEvent(new CustomEvent('forsure-keys-unlocked', { detail: { origin } }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { origin } }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', { detail: { status: origin } }));
    toast.success('Vos messages sont à nouveau déchiffrés');
  };

  const handlePassword = async () => {
    if (!user?.id || !password) return;
    setBusy(true);
    try {
      const status = await initAccountKeySync(password, user.id);
      if (status === 'restored' || status === 'local_ok') {
        finish('password_restore');
      } else if (status === 'no_backup') {
        toast.error('Aucune sauvegarde trouvée pour ce compte');
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

  return (
    <Dialog open={open} onOpenChange={(value) => { if (busy) return; setOpen(value); if (!value) releaseRecoveryDialog(DIALOG_OWNER); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <DialogTitle>Restaurer vos messages chiffrés</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>
              Vos messages sont protégés par chiffrement de bout en bout. Le cache de votre
              navigateur a été vidé, vos clés locales ont disparu.
            </p>
            <p>
              Le coffre restaure uniquement votre identité de compte. Les clés propres à cet appareil
              seront recréées après validation, sans écraser une identité locale différente.
            </p>
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
