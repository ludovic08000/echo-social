import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';
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

/** Read-only iOS Web Passkey diagnostics. */
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
    if (!isIosWebRuntime()) return;
    void load();
  }, [load]);

  if (!isIosWebRuntime()) return null;

  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-primary" />
        <span className="font-semibold">Diagnostic iOS Web</span>
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
          <div className="sm:col-span-2"><span className="text-muted-foreground">Device ID : </span><span className="break-all font-mono">{report.deviceId ?? 'inconnu'}</span></div>
          <div><span className="text-muted-foreground">Binding serveur : </span>{line(report.bindingStatus === 'bound', 'bound', report.bindingStatus ?? 'inconnu')}</div>
          <div><span className="text-muted-foreground">Routing : </span>{line(report.routingStatus === 'ready', 'ready', report.routingStatus ?? 'inconnu')}</div>
          <div><span className="text-muted-foreground">SPK : </span><span className="font-mono">{report.spkCount ?? '…'}</span></div>
          <div><span className="text-muted-foreground">OPK : </span><span className="font-mono">{report.opkCount ?? '…'}</span></div>
          <div><span className="text-muted-foreground">Passkey iOS : </span>{line(report.passkeySupported, 'disponible', 'indisponible')}</div>
          <div>
            <span className="text-muted-foreground">Credential passkey : </span>
            {report.passkeyRegistered === null
              ? <span className="font-mono text-muted-foreground">inconnu</span>
              : line(report.passkeyRegistered, 'enregistrée', 'non enregistrée')}
          </div>
          {report.passkeyLastError ? (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground">Erreur passkey : </span>
              <span className="break-all font-mono text-destructive">{report.passkeyLastError}</span>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">Dernière erreur protocole : </span>
            {report.lastRpcError
              ? <span className="break-all font-mono text-destructive">{report.lastRpcError}</span>
              : <span className="text-emerald-600 dark:text-emerald-400">aucune</span>}
          </div>
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">Dernière erreur routing : </span>
            {report.lastError
              ? <span className="break-all font-mono text-destructive">{report.lastError}</span>
              : <span className="text-emerald-600 dark:text-emerald-400">aucune</span>}
          </div>
        </div>
      )}
    </div>
  );
}
