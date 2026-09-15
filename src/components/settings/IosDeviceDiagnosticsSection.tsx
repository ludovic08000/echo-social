import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';
import {
  collectIosDeviceDiagnostics,
  type IosDeviceDiagnosticsReport,
  type IosDiagnosticsServerContext,
} from '@/platforms/ios/iosDiagnostics';

interface Props {
  userId: string | null;
  deviceId: string | null;
  server: IosDiagnosticsServerContext;
}

function line(ok: boolean, okLabel: string, badLabel: string) {
  return (
    <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
      {ok ? `✓ ${okLabel}` : `• ${badLabel}`}
    </span>
  );
}

/** Bloc de debug iOS isolé : lecture seule, sans impact sur le flux Windows. */
export function IosDeviceDiagnosticsSection({ userId, deviceId, server }: Props) {
  const [report, setReport] = useState<IosDeviceDiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await collectIosDeviceDiagnostics({ userId, deviceId, server }));
    } finally {
      setLoading(false);
    }
  }, [userId, deviceId, server]);

  useEffect(() => {
    if (!isIosRuntime()) return;
    void load();
  }, [load]);

  if (!isIosRuntime()) return null;

  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-primary" />
        <span className="font-semibold">Diagnostic iOS</span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Actualiser le diagnostic iOS"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {!report ? (
        <p className="mt-2 text-muted-foreground">Analyse en cours…</p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div><span className="text-muted-foreground">Plateforme : </span><span className="font-mono">{report.platform}</span></div>
          <div><span className="text-muted-foreground">App / modèle : </span><span className="font-mono">{report.appVersion ?? '—'} · {report.deviceModel ?? '—'}</span></div>
          <div className="sm:col-span-2"><span className="text-muted-foreground">Device ID : </span><span className="break-all font-mono">{report.deviceId ?? 'inconnu'}</span></div>
          <div><span className="text-muted-foreground">DeviceID ancré : </span>{line(report.deviceIdAnchored, 'Keychain', 'non ancré')}</div>
          <div><span className="text-muted-foreground">Keychain : </span>{line(report.keychainState === 'ok', `${report.keychainTier}`, `${report.keychainState} (${report.keychainTier})`)}</div>
          <div><span className="text-muted-foreground">Identité locale : </span>{line(report.hasLocalIdentity, 'présente', 'absente')}</div>
          <div><span className="text-muted-foreground">Secure Enclave : </span>{line(report.secureEnclaveAvailable, report.secureEnclaveBacking, report.secureEnclaveBacking)}</div>
          <div><span className="text-muted-foreground">Binding serveur : </span>{line(report.bindingStatus === 'bound', 'bound', report.bindingStatus ?? 'inconnu')}</div>
          <div><span className="text-muted-foreground">Routing : </span>{line(report.routingStatus === 'ready', 'ready', report.routingStatus ?? 'inconnu')}</div>
          <div><span className="text-muted-foreground">SPK : </span><span className="font-mono">{report.spkCount ?? '…'}</span></div>
          <div><span className="text-muted-foreground">OPK : </span><span className="font-mono">{report.opkCount ?? '…'}</span></div>
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">Dernière erreur RPC : </span>
            {report.lastRpcError
              ? <span className="break-all font-mono text-destructive">{report.lastRpcError}</span>
              : <span className="text-emerald-600 dark:text-emerald-400">aucune</span>}
          </div>
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">Dernière erreur : </span>
            {report.lastError
              ? <span className="break-all font-mono text-destructive">{report.lastError}</span>
              : <span className="text-emerald-600 dark:text-emerald-400">aucune</span>}
          </div>
        </div>

      )}
    </div>
  );
}
