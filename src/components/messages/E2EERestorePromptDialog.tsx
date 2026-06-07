/**
 * E2EERestorePromptDialog
 *
 * Inspired by Signal "Restore from backup" / WhatsApp "Encrypted backup" flow.
 *
 * Three restoration paths:
 *   1. Account password   (always available if a v5+ backup exists)
 *   2. 64-hex recovery key (if generated from Settings → Security)
 *   3. 6-digit backup PIN (L5 — WhatsApp-style, server-rate-limited 10/24h)
 *
 * Triggered by E2EE restore/unlock window events.
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
import { Loader2, KeyRound, Lock, ShieldCheck, Hash, QrCode, Copy, Download } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { useDeviceLink } from '@/hooks/useDeviceLink';
import {
  initAccountKeySync,
  restoreWithRecoveryKey,
  restoreWithBackupPin,
  hasBackupPin,
  hasLocalKeys,
} from '@/lib/crypto/accountKeyBackup';

export function E2EERestorePromptDialog() {
  const { user } = useAuth();
  const deviceLink = useDeviceLink();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [pin, setPin] = useState('');
  const [tab, setTab] = useState<'password' | 'recovery' | 'pin' | 'device'>('password');
  const [pinAvailable, setPinAvailable] = useState(false);
  const [linkQrData, setLinkQrData] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');

  useEffect(() => {
    let disposed = false;

    const prefersPin = (eventType: string, detail: Record<string, unknown>) => {
      const haystack = [
        eventType,
        detail.reason,
        detail.source,
        detail.preferredMethod,
        detail.status,
        detail.initError,
        ...(Array.isArray(detail.errors) ? detail.errors : []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes('pin') || haystack.includes('unlock');
    };

    const onNeeded = async (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {};
      const detailUserId = typeof detail.userId === 'string' ? detail.userId : null;
      if (detailUserId && user?.id && detailUserId !== user.id) return;
      try {
        if (await hasLocalKeys()) return;
      } catch {}
      console.warn('[E2EERestore] prompting user to restore keys', detail);

      if (user?.id) {
        try {
          const hasPin = await hasBackupPin(user.id);
          if (disposed) return;
          setPinAvailable(hasPin);
          if (hasPin && prefersPin(ev.type, detail)) {
            setTab('pin');
          }
        } catch {
          if (disposed) return;
          setPinAvailable(false);
        }
      }
      setOpen(true);
    };

    const events = [
      'forsure:e2ee-restore-needed',
      'forsure:e2ee-pin-unlock-required',
      'forsure-pin-required-for-keys',
      'forsure-identity-lost',
      'forsure:device-kx-restore-required',
    ];

    events.forEach((name) => window.addEventListener(name, onNeeded as EventListener));
    return () => {
      disposed = true;
      events.forEach((name) => window.removeEventListener(name, onNeeded as EventListener));
    };
  }, [user?.id]);

  useEffect(() => {
    if (!open) return;
    const onRestored = () => {
      setOpen(false);
      setPassword(''); setRecoveryKey(''); setPin('');
      setLinkQrData(null); setLinkInput('');
      toast.success('Messages déverrouillés');
    };
    window.addEventListener('forsure-keys-restored', onRestored);
    return () => window.removeEventListener('forsure-keys-restored', onRestored);
  }, [open]);

  const finish = (origin: string) => {
    setOpen(false);
    setPassword(''); setRecoveryKey(''); setPin('');
    setLinkQrData(null); setLinkInput('');
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
      if (ok) finish('recovery_restore');
      else toast.error('Clé de récupération invalide');
    } catch (e) {
      console.error('[E2EERestore] recovery restore failed', e);
      toast.error('Échec de la restauration');
    } finally {
      setBusy(false);
    }
  };

  const handlePin = async () => {
    if (!user?.id || pin.length !== 6) return;
    setBusy(true);
    try {
      const result = await restoreWithBackupPin(pin, user.id);
      if (result.status === 'restored') {
        finish('pin_restore');
      } else if (result.status === 'wrong_pin') {
        const remaining = typeof result.attemptsRemaining === 'number' ? result.attemptsRemaining : null;
        toast.error(remaining !== null ? `Code PIN incorrect — ${remaining} essai(s) restant(s)` : 'Code PIN incorrect');
      } else if (result.status === 'locked') {
        const until = result.lockedUntil ? new Date(result.lockedUntil).toLocaleString('fr-FR') : '24 h';
        toast.error(`Trop d'essais. Réessayez après le ${until}`);
      } else if (result.status === 'no_backup') {
        toast.error('Aucune sauvegarde par PIN trouvée');
      } else {
        toast.error('Échec de la restauration par PIN');
      }
    } catch (e) {
      console.error('[E2EERestore] pin restore failed', e);
      toast.error('Échec de la restauration');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateDeviceLink = async () => {
    setBusy(true);
    try {
      const result = await deviceLink.createLinkRequest();
      if (!result) {
        toast.error(deviceLink.error || 'Impossible de creer la demande de liaison');
        return;
      }
      setLinkQrData(result.qrData);
      setLinkInput(result.qrData);
      toast.success('Demande de liaison creee. Approuve-la depuis un appareil deja connecte.');
    } finally {
      setBusy(false);
    }
  };

  const handleClaimDeviceLink = async () => {
    const code = linkInput.trim() || linkQrData || '';
    if (!code) return;
    setBusy(true);
    try {
      const ok = await deviceLink.claimApprovedLink(code);
      if (ok) {
        finish('device_link_restore');
      } else if ((deviceLink.error || '').toLowerCase().includes('attente')) {
        toast.info(deviceLink.error || 'En attente d approbation depuis un autre appareil');
      } else {
        toast.error(deviceLink.error || 'Transfert de cles indisponible');
      }
    } finally {
      setBusy(false);
    }
  };

  const copyLinkCode = () => {
    if (!linkQrData) return;
    navigator.clipboard.writeText(linkQrData).then(
      () => toast.success('Code de liaison copie'),
      () => toast.error('Copie impossible'),
    );
  };

  const tabGridClass = pinAvailable ? 'grid-cols-4' : 'grid-cols-3';

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
              Choisissez une méthode pour la déverrouiller.
            </p>
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className={`grid w-full ${tabGridClass}`}>
            <TabsTrigger value="password">
              <Lock className="w-4 h-4 mr-1" /> Mot de passe
            </TabsTrigger>
            <TabsTrigger value="recovery">
              <KeyRound className="w-4 h-4 mr-1" /> Clé
            </TabsTrigger>
            {pinAvailable && (
              <TabsTrigger value="pin">
                <Hash className="w-4 h-4 mr-1" /> PIN
              </TabsTrigger>
            )}
            <TabsTrigger value="device">
              <QrCode className="w-4 h-4 mr-1" /> Appareil
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

          {pinAvailable && (
            <TabsContent value="pin" className="space-y-3 pt-3">
              <Label htmlFor="restore-pin">Code PIN à 6 chiffres</Label>
              <Input
                id="restore-pin"
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                disabled={busy}
                autoComplete="off"
                className="text-center tracking-[0.5em] text-xl"
                onKeyDown={(e) => { if (e.key === 'Enter' && pin.length === 6) handlePin(); }}
              />
              <p className="text-xs text-muted-foreground">
                Limité à 10 essais par 24 h. Si vous l'oubliez, utilisez votre mot de passe ou la clé de récupération.
              </p>
              <Button onClick={handlePin} disabled={busy || pin.length !== 6} className="w-full">
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Déverrouiller avec le PIN
              </Button>
            </TabsContent>
          )}

          <TabsContent value="device" className="space-y-3 pt-3">
            <p className="text-xs text-muted-foreground">
              Si cet iPhone a perdu son cache, cree une demande ici. Puis approuve-la depuis un
              appareil deja connecte avec le QR/code ci-dessous.
            </p>
            <Button onClick={handleCreateDeviceLink} disabled={busy} className="w-full">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <QrCode className="w-4 h-4 mr-2" />}
              Creer une demande de liaison
            </Button>

            {linkQrData && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-3">
                <div className="flex justify-center">
                  <div className="bg-white p-3 rounded-lg">
                    <QRCodeSVG value={linkQrData} size={176} level="M" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <code className="text-[10px] bg-background p-2 rounded flex-1 break-all max-h-16 overflow-auto">
                    {linkQrData}
                  </code>
                  <Button type="button" variant="outline" size="icon" onClick={copyLinkCode}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            <Label htmlFor="device-link-code">Code de liaison</Label>
            <Input
              id="device-link-code"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="Colle le code si le QR a disparu"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button onClick={handleClaimDeviceLink} disabled={busy || (!linkInput.trim() && !linkQrData)} className="w-full">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
              Recuperer les cles approuvees
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
