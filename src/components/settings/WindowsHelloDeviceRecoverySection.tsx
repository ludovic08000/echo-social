import { useEffect, useState } from 'react';
import { Fingerprint, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSessionMasterKey, initAccountKeySync } from '@/lib/crypto/accountKeyBackup';
import {
  getWindowsHelloRecoveryStatus,
  isWindowsHelloAvailable,
  isWindowsWeb,
  registerCurrentWindowsHelloDevice,
} from '@/lib/crypto/windowsHelloDeviceRecovery';

export function WindowsHelloDeviceRecoverySection({
  userId,
  deviceId,
}: {
  userId: string;
  deviceId: string | null;
}) {
  const [available, setAvailable] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!isWindowsWeb()) {
        if (!cancelled) setLoading(false);
        return;
      }
      const supported = await isWindowsHelloAvailable();
      if (cancelled) return;
      setAvailable(supported);
      if (!supported || !deviceId) {
        setRegistered(false);
        setLoading(false);
        return;
      }
      try {
        setRegistered(await getWindowsHelloRecoveryStatus(deviceId));
      } catch {
        setRegistered(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [deviceId]);

  if (!isWindowsWeb()) return null;

  if (loading) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Vérification de Windows Hello…
        </div>
      </div>
    );
  }

  const canActivate = Boolean(deviceId && available);

  const activate = async () => {
    if (busy || !deviceId || !available) return;
    if (!getSessionMasterKey() && !password) {
      setNeedsPassword(true);
      return;
    }
    setBusy(true);
    try {
      if (!getSessionMasterKey()) {
        const status = await initAccountKeySync(password, userId);
        if (status !== 'restored' && status !== 'local_ok') {
          throw new Error(status === 'no_backup' ? 'Aucune sauvegarde de compte disponible.' : 'Mot de passe incorrect ou sauvegarde illisible.');
        }
      }
      await registerCurrentWindowsHelloDevice({ userId, deviceId });
      setRegistered(true);
      setNeedsPassword(false);
      setPassword('');
      toast.success('Windows Hello protège maintenant la récupération de cet appareil');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Échec de Windows Hello');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {registered ? <ShieldCheck className="h-5 w-5" /> : <Fingerprint className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Windows Hello</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {registered
              ? 'Ce device peut être restauré avec Windows Hello après suppression des données du navigateur, sans créer un nouveau DeviceID.'
              : !deviceId
                ? 'Windows Hello est disponible. Enregistrez et approuvez d’abord cet appareil, puis activez sa récupération ici.'
                : !available
                  ? 'Windows Hello/WebAuthn n’est pas disponible dans ce navigateur ou sur cette machine.'
                  : 'Associez Windows Hello à ce device pour pouvoir restaurer le même DeviceID et ses clés après suppression des données du navigateur.'}
          </p>
        </div>
      </div>

      {!registered && needsPassword && canActivate && (
        <Input
          className="mt-3"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Mot de passe du compte"
        />
      )}

      {!registered && (
        <Button className="mt-3 w-full" disabled={busy || !canActivate} onClick={() => void activate()}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
          Activer Windows Hello
        </Button>
      )}
    </div>
  );
}
