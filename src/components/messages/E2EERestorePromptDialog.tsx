/**
 * E2EERestorePromptDialog
 *
 * Inspired by Signal "Restore from backup" / WhatsApp "Encrypted backup" flow.
 *
 * When the local IndexedDB is wiped (browser cache cleared, iOS ITP purge,
 * "clear site data") but the Supabase auth session is still valid, the
 * server still holds the encrypted Master Key backup. We just need the user
 * to re-enter their password (or recovery key) so we can unwrap it.
 *
 * Without this prompt, the user would simply see "messages locked" forever.
 *
 * Triggered by the `forsure:e2ee-restore-needed` window event.
 */
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
  restoreWithRecoveryKey,
  hasLocalKeys,
} from '@/lib/crypto/accountKeyBackup';

export function E2EERestorePromptDialog() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [tab, setTab] = useState<'password' | 'recovery'>('password');

  useEffect(() => {
    const onNeeded = async (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {};
      // Last-chance: keys may have been restored silently in parallel.
      try {
        if (await hasLocalKeys()) return;
      } catch {}
      console.warn('[E2EERestore] prompting user to restore keys', detail);
      setOpen(true);
    };
    window.addEventListener('forsure:e2ee-restore-needed', onNeeded as EventListener);
    return () => window.removeEventListener('forsure:e2ee-restore-needed', onNeeded as EventListener);
  }, []);

  // Auto-close if keys appear (e.g. another tab restored, or background sync succeeded)
  useEffect(() => {
    if (!open) return;
    const onRestored = () => {
      setOpen(false);
      setPassword('');
      setRecoveryKey('');
      toast.success('Messages déverrouillés');
    };
    window.addEventListener('forsure-keys-restored', onRestored);
    return () => window.removeEventListener('forsure-keys-restored', onRestored);
  }, [open]);

  const finish = (origin: string) => {
    setOpen(false);
    setPassword('');
    setRecoveryKey('');
    // Re-trigger media/decrypt pipelines so already-rendered conversations refresh.
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
    } catch (e) {
      console.error('[E2EERestore] password restore failed', e);
      toast.error('Échec de la restauration');
    } finally {
      setBusy(false);
    }
  };

  const handleRecovery = async () => {
    if (!user?.id || !recoveryKey.trim()) return;
    setBusy(true);
    try {
      const ok = await restoreWithRecoveryKey(recoveryKey.trim(), user.id);
      if (ok) {
        finish('recovery_restore');
      } else {
        toast.error('Clé de récupération invalide');
      }
    } catch (e) {
      console.error('[E2EERestore] recovery restore failed', e);
      toast.error('Échec de la restauration');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
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
              Une sauvegarde chiffrée existe sur nos serveurs (style Signal / WhatsApp).
              Saisissez votre mot de passe pour la déverrouiller.
            </p>
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'password' | 'recovery')}>
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="password">
              <Lock className="w-4 h-4 mr-2" /> Mot de passe
            </TabsTrigger>
            <TabsTrigger value="recovery">
              <KeyRound className="w-4 h-4 mr-2" /> Clé de récupération
            </TabsTrigger>
          </TabsList>

          <TabsContent value="password" className="space-y-3 pt-3">
            <Label htmlFor="restore-password">Mot de passe du compte</Label>
            <Input
              id="restore-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePassword(); }}
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
              onChange={(e) => setRecoveryKey(e.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRecovery(); }}
            />
            <p className="text-xs text-muted-foreground">
              Utilisez la clé sauvegardée depuis Réglages → Sécurité.
            </p>
            <Button onClick={handleRecovery} disabled={busy || !recoveryKey.trim()} className="w-full">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Restaurer avec la clé
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter className="text-xs text-muted-foreground">
          Aucune donnée n'est envoyée en clair. Le déchiffrement se fait localement.
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
