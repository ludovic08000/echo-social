import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Fingerprint, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { deviceApi, type DeviceApiRecord } from '@/lib/api/deviceApi';
import { getSessionMasterKey, initAccountKeySync } from '@/lib/crypto/accountKeyBackup';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';
import {
  getIosPasskeyStatus,
  isIosPasskeySupported,
  recoverIosDeviceWithPasskey,
  registerIosPasskey,
} from '@/platforms/ios/iosPasskeyProvider';
import {
  inspectIosMessagingIntegrity,
  repairIosMessagingPrekeys,
  type IosMessagingIntegrityReport,
} from '@/platforms/ios/iosMessagingProtection';

function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[360px] items-center justify-center overflow-y-auto bg-background px-3 py-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

export function IosMessagingProtectionGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const iosWeb = isIosWebRuntime();
  const [record, setRecord] = useState<DeviceApiRecord | null>(null);
  const [report, setReport] = useState<IosMessagingIntegrityReport | null>(null);
  const [passkeySupported, setPasskeySupported] = useState<boolean | null>(null);
  const [passkeyRegistered, setPasskeyRegistered] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(iosWeb);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repairAttemptedRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!iosWeb || !user?.id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const snapshot = await deviceApi.getState(user.id);
      const nextRecord = snapshot.record;
      setRecord(nextRecord);

      // The outer canonical device gate owns non-ready states.
      if (!nextRecord || snapshot.state !== 'ready') {
        setReport(null);
        setPasskeySupported(null);
        setPasskeyRegistered(null);
        return;
      }

      let nextReport = await inspectIosMessagingIntegrity(user.id, nextRecord);

      // iOS-only self-repair: if the canonical Ed25519/X25519 identity is still
      // intact but Safari lost local SPK/OPK private material, rotate those
      // prekeys and discard only this iOS device's stale ratchet sessions.
      if (
        nextReport.issue === 'local-prekeys-missing'
        && nextReport.repairablePrekeys
        && repairAttemptedRef.current !== nextRecord.deviceId
      ) {
        repairAttemptedRef.current = nextRecord.deviceId;
        await repairIosMessagingPrekeys(user.id, nextRecord);
        nextReport = await inspectIosMessagingIntegrity(user.id, nextRecord);
      }

      // Passkey status is read even when the local device keys are damaged.
      // That keeps the verified recovery path available instead of forcing a
      // new DeviceID when a valid iOS vault already exists server-side.
      const supported = await isIosPasskeySupported();
      const registered = supported ? await getIosPasskeyStatus(nextRecord.deviceId) : false;
      setPasskeySupported(supported);
      setPasskeyRegistered(registered);
      setReport(nextReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'IOS_MESSAGING_PROTECTION_CHECK_FAILED');
    } finally {
      setLoading(false);
    }
  }, [iosWeb, user?.id]);

  useEffect(() => {
    if (!iosWeb) return;
    void refresh();
    const onRefresh = () => void refresh();
    const events = [
      'forsure:device-approved',
      'forsure:device-account-bound',
      'forsure:aegis-route-ready',
      'forsure:webauthn-device-restored',
      'forsure-device-prekeys-repaired',
    ];
    events.forEach((name) => window.addEventListener(name, onRefresh));
    return () => events.forEach((name) => window.removeEventListener(name, onRefresh));
  }, [iosWeb, refresh]);

  if (!iosWeb) return <>{children}</>;
  if (!user) return <>{children}</>;

  // The parent DeviceApprovalGate will render the canonical pending/binding UI.
  if (!loading && record && (
    record.approvalStatus !== 'approved'
    || record.bindingStatus !== 'bound'
    || record.routingStatus !== 'ready'
    || record.lifecycleStatus !== 'ready'
  )) {
    return <>{children}</>;
  }

  const ensureMasterKey = async (): Promise<boolean> => {
    if (getSessionMasterKey()) return true;
    if (!password) {
      setNeedsPassword(true);
      return false;
    }
    const status = await initAccountKeySync(password, user.id);
    if (status !== 'restored' && status !== 'local_ok') {
      throw new Error(status === 'no_backup'
        ? 'Aucune sauvegarde de compte disponible pour protéger les clés de cet iPhone.'
        : 'Mot de passe incorrect ou sauvegarde du compte illisible.');
    }
    return true;
  };

  const activatePasskey = async () => {
    if (!record || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!await ensureMasterKey()) return;
      await registerIosPasskey({ userId: user.id, deviceId: record.deviceId });
      setPassword('');
      setNeedsPassword(false);
      setPasskeyRegistered(true);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'IOS_PASSKEY_ACTIVATION_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const recoverWithPasskey = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!await ensureMasterKey()) return;
      await recoverIosDeviceWithPasskey(user.id);
      setPassword('');
      setNeedsPassword(false);
      repairAttemptedRef.current = null;
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'IOS_PASSKEY_DEVICE_RECOVERY_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const reenroll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const pending = await deviceApi.enroll(user.id);
      window.dispatchEvent(new CustomEvent('forsure:device-approval-pending', {
        detail: { deviceId: pending.deviceId, source: 'ios-integrity-reenroll' },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'IOS_DEVICE_REENROLL_FAILED');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !report) {
    return (
      <GateShell>
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Vérification cryptographique de l’iPhone…</p>
          <p className="text-xs text-muted-foreground">DeviceID, Ed25519, X25519, SPK et OPK sont vérifiés localement contre le serveur.</p>
        </div>
      </GateShell>
    );
  }

  if (report.issue === 'local-device-keys-missing' || report.issue === 'local-device-key-mismatch') {
    return (
      <GateShell>
        <div className="rounded-2xl border border-destructive/30 bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-destructive/10">
              <ShieldAlert className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <h2 className="text-base font-bold">Clés de cet iPhone incohérentes</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                La clé privée locale ne correspond plus au DeviceID approuvé. La messagerie est bloquée pour éviter d’envoyer des capsules impossibles à déchiffrer.
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            Ed25519 : {report.signingKeyMatches ? 'OK' : 'KO'} · X25519 : {report.kxKeyMatches ? 'OK' : 'KO'}
          </div>

          {error && <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

          {needsPassword && !getSessionMasterKey() && (
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

          {passkeyRegistered === true && (
            <Button variant="outline" className="mt-3 w-full rounded-xl" disabled={busy} onClick={() => void recoverWithPasskey()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
              Restaurer exactement ce device avec Face ID
            </Button>
          )}

          <Button className="mt-2 w-full rounded-xl" disabled={busy} onClick={() => void reenroll()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}
            Réenregistrer cet iPhone comme nouvel appareil
          </Button>
          <p className="mt-2 text-center text-[10px] text-muted-foreground">Le nouvel appareil devra être approuvé depuis un appareil déjà reconnu.</p>
        </div>
      </GateShell>
    );
  }

  if (report.issue === 'local-prekeys-missing') {
    return (
      <GateShell>
        <div className="rounded-2xl border border-amber-500/30 bg-card p-5 text-center shadow-sm">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-amber-600" />
          <p className="mt-3 text-sm font-semibold">Réparation des préclés iOS…</p>
          <p className="mt-1 text-xs text-muted-foreground">Les SPK/OPK locales ne correspondent pas au serveur. Elles sont remplacées avant tout nouvel échange X3DH.</p>
          <Button variant="outline" className="mt-4" onClick={() => { repairAttemptedRef.current = null; void refresh(); }}>
            <RefreshCw className="mr-2 h-4 w-4" /> Réessayer
          </Button>
        </div>
      </GateShell>
    );
  }

  if (report.issue === 'integrity-check-failed') {
    return (
      <GateShell>
        <div className="rounded-2xl border border-destructive/30 bg-card p-5 text-center shadow-sm">
          <ShieldAlert className="mx-auto h-6 w-6 text-destructive" />
          <p className="mt-3 text-sm font-semibold">Vérification de sécurité impossible</p>
          <p className="mt-1 text-xs text-muted-foreground">La messagerie reste bloquée tant que l’intégrité locale du device ne peut pas être confirmée.</p>
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
          <Button variant="outline" className="mt-4" onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" /> Réessayer</Button>
        </div>
      </GateShell>
    );
  }

  if (passkeySupported === false) {
    return (
      <GateShell>
        <div className="rounded-2xl border border-destructive/30 bg-card p-5 text-center shadow-sm">
          <KeyRound className="mx-auto h-6 w-6 text-destructive" />
          <p className="mt-3 text-sm font-semibold">Passkey iOS indisponible</p>
          <p className="mt-1 text-xs text-muted-foreground">La sauvegarde chiffrée des clés device est obligatoire avant d’activer la messagerie sur cet iPhone.</p>
          <Button variant="outline" className="mt-4" onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" /> Vérifier à nouveau</Button>
        </div>
      </GateShell>
    );
  }

  if (passkeyRegistered !== true) {
    return (
      <GateShell>
        <div className="rounded-2xl border border-primary/30 bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-bold">Sauvegarder les clés de cet iPhone</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Avant la messagerie, Face ID / Passkey doit sceller une sauvegarde chiffrée du DeviceID et des clés privées Ed25519 + X25519. Le serveur ne reçoit jamais les clés en clair.
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            DeviceID : {record?.deviceId ?? report.deviceId ?? '—'} · SPK : {report.spkMatches ? 'OK' : 'KO'} · OPK serveur/local : {report.serverOpkCount}/{report.localOpkCount}
          </div>

          {error && <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

          {needsPassword && !getSessionMasterKey() && (
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

          <Button className="mt-3 w-full rounded-xl" disabled={busy || !record} onClick={() => void activatePasskey()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
            Protéger cet iPhone avec Face ID / Passkey
          </Button>
        </div>
      </GateShell>
    );
  }

  return <>{children}</>;
}
