import { useEffect, useState } from 'react';
import { Fingerprint, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSessionMasterKey, initAccountKeySync } from '@/lib/crypto/accountKeyBackup';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';
import {
  getIosPasskeyStatus,
  isIosPasskeySupported,
  registerIosPasskey,
} from '@/platforms/ios/iosPasskeyProvider';

export function IosPasskeyRecoverySection({
  userId,
  deviceId,
  ready,
}: {
  userId: string;
  deviceId: string | null;
  ready: boolean;
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
      if (!isIosWebRuntime()) {
        if (!cancelled) setLoading(false);
        return;
      }
      const supported = await isIosPasskeySupported();
      if (cancelled) return;
      setAvailable(supported);
      if (!supported || !deviceId || !ready) {
        setRegistered(false);
        setLoading(false);
        return;
      }
      try {
        setRegistered(await getIosPasskeyStatus(deviceId));
      } catch {
        setRegistered(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [deviceId, ready]);

  if (!isIosWebRuntime()) return null;

  if (loading) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Vérification de la Passkey iOS…
        </div>
      </div>
    );
  }

  const canActivate = Boolean(deviceId && ready && available);

  const activate = async () => {
    if (busy || !deviceId || !canActivate) return;
    if (!getSessionMasterKey() && !password) {
      setNeedsPassword(true);
      return;
    }

    setBusy(true);
    try {
      if (!getSessionMasterKey()) {
        const status = await initAccountKeySync(password, userId);
        if (status !== 'restored' && status !== 'local_ok') {
          throw new Error(status === 'no_backup'
            ? 'Aucune sauvegarde de compte disponible.'
            : 'Mot de passe incorrect ou sauvegarde illisible.');
        }
      }

      await registerIosPasskey({ userId, deviceId });
      setRegistered(true);
      setNeedsPassword(false);
      setPassword('');
      toast.success('La Passkey protège maintenant la récupération de cet iPhone/iPad');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Échec de la Passkey iOS');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {registered ? <ShieldCheck className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Passkey iOS</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {registered
              ? 'Ce device peut être restauré avec Face ID/Touch ID après suppression des données Safari, sans créer un nouveau DeviceID.'
              : !deviceId
                ? 'Enregistrez et approuvez d’abord cet appareil.'
                : !ready
                  ? 'La Passkey sera activable dès que le device aura terminé binding, SPK/OPK et routing.'
                  : !available
                    ? 'WebAuthn/Passkeys n’est pas disponible dans ce navigateur iOS.'
                    : 'Associez une Passkey Apple à ce device pour restaurer exactement le même DeviceID et les mêmes clés E2EE après une purge Safari.'}
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
          Activer la Passkey iOS
        </Button>
      )}
    </div>
  );
}
