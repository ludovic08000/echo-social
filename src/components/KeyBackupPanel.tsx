import { useState, useEffect } from 'react';
import { Shield, QrCode, Download, Upload, Loader2, AlertCircle, Copy, RefreshCw, Cloud, Bug, ChevronDown, ChevronUp, KeyRound } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { useDeviceLink } from '@/hooks/useDeviceLink';
import { isAnyBackupSyncActive, syncAvailableBackupsToServer, hasLocalKeys } from '@/lib/crypto/accountKeyBackup';
import { resyncE2EE, type ResyncReport } from '@/lib/crypto/resyncE2EE';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export function KeyBackupPanel() {
  const backup = useSecureBackup();
  const deviceLink = useDeviceLink();
  const { user } = useAuth();
  const [hasExisting, setHasExisting] = useState(false);
  const [autoBackupOn, setAutoBackupOn] = useState(false);
  const [hasLocal, setHasLocal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [diagMode, setDiagMode] = useState(false);
  const [lastReport, setLastReport] = useState<ResyncReport | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<'create' | 'restore' | null>(null);
  // Device transfer
  const [qrData, setQrData] = useState<string | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [approvalInput, setApprovalInput] = useState('');

  useEffect(() => {
    backup.hasBackup().then(setHasExisting);
    setAutoBackupOn(isAnyBackupSyncActive(user?.id));
    hasLocalKeys().then(setHasLocal);
  }, [user?.id]);

  const handleForceSync = async () => {
    if (!user) { toast.error('Connecte-toi pour synchroniser'); return; }
    setSyncing(true);
    try {
      const ok = await syncAvailableBackupsToServer(user.id);
      if (ok) {
        toast.success('Clés synchronisées avec le serveur ✅');
        setHasExisting(true);
      } else {
        toast.error('Aucune clé locale à sauvegarder');
      }
    } catch {
      toast.error('Échec de la synchronisation');
    } finally {
      setSyncing(false);
    }
  };

  const handleResync = async () => {
    if (!user) { toast.error('Connecte-toi pour re-synchroniser'); return; }
    setResyncing(true);
    setShowTrace(false);
    try {
      const report = await resyncE2EE(user.id, { diagnostic: diagMode });
      setLastReport(report);
      if (report.ok) {
        const recovered = report.recoveredMessages;
        toast.success(
          recovered > 0
            ? `Re-sync réussi · ${recovered} message${recovered > 1 ? 's' : ''} récupéré${recovered > 1 ? 's' : ''}`
            : 'Re-sync réussi · identité republiée',
        );
      } else {
        toast.warning(`Re-sync partiel · ${report.errors.length} étape(s) en échec`);
      }
      if (diagMode) setShowTrace(true);
      setHasExisting(true);
    } catch (e) {
      console.error('[resync] failed', e);
      toast.error('Re-sync échoué');
    } finally {
      setResyncing(false);
    }
  };

  const copyDiagReport = () => {
    if (!lastReport) return;
    const payload = JSON.stringify(lastReport, null, 2);
    navigator.clipboard.writeText(payload);
    toast.success('Trace diagnostic copiée');
  };

  const handleCreateLink = async () => {
    const result = await deviceLink.createLinkRequest();
    if (result) {
      setQrData(result.qrData);
      setScanInput(result.qrData);
      toast.success('Demande de liaison creee (expire dans 10 min)');
    } else {
      toast.error(deviceLink.error || 'Erreur');
    }
  };

  const handleCreateRecoveryKey = async () => {
    if (!user) { toast.error('Connecte-toi pour creer une cle'); return; }
    setRecoveryBusy('create');
    try {
      const key = await backup.createBackup();
      if (!key) {
        toast.error(backup.error || 'Creation impossible');
        return;
      }
      setGeneratedRecoveryKey(key);
      setHasExisting(true);
      toast.success('Cle de recuperation creee');
    } finally {
      setRecoveryBusy(null);
    }
  };

  const handleRestoreRecoveryKey = async () => {
    if (!user) { toast.error('Connecte-toi pour restaurer'); return; }
    const key = recoveryInput.trim();
    if (!key) { toast.error('Colle ta cle de recuperation'); return; }
    setRecoveryBusy('restore');
    try {
      const ok = await backup.restoreBackup(key);
      if (!ok) {
        toast.error(backup.error || 'Restauration impossible');
        return;
      }
      setRecoveryInput('');
      setHasLocal(true);
      setHasExisting(true);
      try {
        window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
          detail: { status: 'recovery_key_restored' },
        }));
        window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
      } catch {
        /* SSR safe */
      }
      toast.success('Cles restaurees');
    } finally {
      setRecoveryBusy(null);
    }
  };

  const handleApproveLink = async () => {
    if (!approvalInput.trim()) { toast.error('Colle le code QR du nouvel appareil'); return; }
    const ok = await deviceLink.approveLinkRequest(approvalInput);
    if (ok) {
      toast.success('Nouvel appareil approuve. Le transfert chiffre est pret.');
      setApprovalInput('');
    } else {
      toast.error(deviceLink.error || 'Erreur d approbation');
    }
  };

  const handleClaimLink = async () => {
    const code = scanInput.trim() || qrData || '';
    if (!code) { toast.error('Genere ou colle le code de liaison'); return; }
    const ok = await deviceLink.claimApprovedLink(code);
    if (ok) {
      toast.success('Cles transferees avec succes');
    } else if ((deviceLink.error || '').toLowerCase().includes('attente')) {
      toast.info(deviceLink.error || 'En attente d approbation');
    } else {
      toast.error(deviceLink.error || 'Erreur de transfert');
    }
  };

  const copyQrData = () => {
    if (qrData) {
      navigator.clipboard.writeText(qrData);
      toast.success('Code copié !');
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Shield className="h-4 w-4 text-primary" />
          Coffre E2EE — Sauvegarde & Transfert
        </CardTitle>
        <CardDescription className="text-xs">
          Tes clés de chiffrement sont automatiquement sauvegardées avec ton compte. Si tu changes d'appareil ou vides ton cache, elles seront restaurées à la connexion.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="backup" className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-8">
            <TabsTrigger value="backup" className="text-xs gap-1">
              <Cloud className="h-3 w-3" /> Sauvegarde auto
            </TabsTrigger>
            <TabsTrigger value="device" className="text-xs gap-1">
              <QrCode className="h-3 w-3" /> Transfert
            </TabsTrigger>
          </TabsList>

          <TabsContent value="backup" className="space-y-3 mt-3">
            {/* Auto-backup status */}
            <div className="p-3 rounded-lg bg-muted/50 space-y-2">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${autoBackupOn ? 'bg-green-500' : 'bg-yellow-500'}`} />
                <span className="text-xs font-medium">
                  {autoBackupOn ? 'Sauvegarde automatique active' : 'Reconnecte-toi pour activer la sauvegarde auto'}
                </span>
              </div>

              {hasLocal && (
                <p className="text-[10px] text-muted-foreground">
                  ✅ Clés locales présentes — {hasExisting ? 'synchronisées avec le serveur' : 'en attente de synchronisation'}
                </p>
              )}

              {!hasLocal && hasExisting && (
                <p className="text-[10px] text-muted-foreground">
                  ☁️ Sauvegarde disponible — reconnecte-toi pour synchroniser automatiquement
                </p>
              )}

              {!hasLocal && !hasExisting && (
                <p className="text-[10px] text-muted-foreground">
                  ⚠️ Aucune clé locale ni sauvegarde — envoie un premier message chiffré pour générer tes clés
                </p>
              )}
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <KeyRound className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium">Cle de recuperation</span>
              </div>
              <div className="grid grid-cols-1 gap-2">
                <Button
                  onClick={handleCreateRecoveryKey}
                  disabled={backup.isLoading || recoveryBusy !== null || !hasLocal}
                  size="sm"
                  variant="outline"
                  className="w-full gap-1"
                >
                  {recoveryBusy === 'create' ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                  Creer une cle de recuperation
                </Button>
                {generatedRecoveryKey && (
                  <div className="flex gap-1">
                    <code className="text-[10px] bg-background p-2 rounded flex-1 break-all">
                      {generatedRecoveryKey}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard.writeText(generatedRecoveryKey);
                        toast.success('Cle copiee');
                      }}
                      className="shrink-0"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                <div className="flex gap-1">
                  <Input
                    placeholder="Cle de recuperation"
                    value={recoveryInput}
                    onChange={e => setRecoveryInput(e.target.value)}
                    className="h-9 text-xs font-mono"
                  />
                  <Button
                    onClick={handleRestoreRecoveryKey}
                    disabled={backup.isLoading || recoveryBusy !== null || !recoveryInput.trim()}
                    size="sm"
                    variant="secondary"
                    className="shrink-0 gap-1"
                  >
                    {recoveryBusy === 'restore' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    Restaurer
                  </Button>
                </div>
                {backup.error && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> {backup.error}
                  </p>
                )}
              </div>
            </div>

            {/* Manual sync + resync buttons */}
            {hasLocal && (
              <div className="grid grid-cols-1 gap-2">
                {autoBackupOn && (
                  <Button
                    onClick={handleForceSync}
                    disabled={syncing || resyncing}
                    size="sm"
                    variant="outline"
                    className="w-full gap-1"
                  >
                    {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Forcer la synchronisation maintenant
                  </Button>
                )}
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Bug className="h-3.5 w-3.5 text-primary" />
                    <Label htmlFor="diag-mode" className="text-xs cursor-pointer">
                      Mode diagnostic (trace détaillée)
                    </Label>
                  </div>
                  <Switch id="diag-mode" checked={diagMode} onCheckedChange={setDiagMode} />
                </div>
                <Button
                  onClick={handleResync}
                  disabled={resyncing || syncing || !user}
                  size="sm"
                  variant="secondary"
                  className="w-full gap-1"
                >
                  {resyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
                  Synchroniser mes clés E2EE
                </Button>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Republie ton identité, renouvelle les clés à usage unique, invalide les anciens canaux et tente de récupérer les messages illisibles.
                  {diagMode && ' Le mode diagnostic capture chaque étape, les erreurs de déchiffrement et les device-copies récupérées (utile pour iOS).'}
                </p>
              </div>
            )}

            {/* Diagnostic report viewer */}
            {lastReport && (
              <div className="rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowTrace(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/60 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <Bug className="h-3.5 w-3.5 text-primary" />
                    Dernier rapport · {lastReport.ok ? '✅ ok' : `⚠️ ${lastReport.errors.length} erreur(s)`} · {lastReport.recoveredMessages}/{lastReport.scannedMessages} récupéré(s) · {lastReport.durationMs}ms
                  </span>
                  {showTrace ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {showTrace && (
                  <div className="px-3 py-2 space-y-2 border-t border-border/60">
                    <div className="grid grid-cols-2 gap-1 text-[10px]">
                      {Object.entries(lastReport.steps).map(([step, status]) => (
                        <div key={step} className="flex items-center gap-1.5">
                          <span className={
                            status === 'ok' ? 'text-green-500' :
                            status === 'error' ? 'text-destructive' :
                            'text-muted-foreground'
                          }>
                            {status === 'ok' ? '●' : status === 'error' ? '✕' : '○'}
                          </span>
                          <span className="font-mono">{step}</span>
                          <span className="text-muted-foreground">{status}</span>
                        </div>
                      ))}
                    </div>
                    {lastReport.deviceId && (
                      <p className="text-[10px] text-muted-foreground font-mono">
                        device {lastReport.deviceId.slice(0, 12)}… · {lastReport.platform}
                      </p>
                    )}
                    {lastReport.errors.length > 0 && (
                      <div className="rounded bg-destructive/10 px-2 py-1.5 space-y-0.5">
                        {lastReport.errors.map((err, i) => (
                          <p key={i} className="text-[10px] text-destructive font-mono break-all">
                            ✕ {err}
                          </p>
                        ))}
                      </div>
                    )}
                    {lastReport.trace && lastReport.trace.length > 0 && (
                      <div className="rounded bg-background/60 p-2 max-h-56 overflow-auto space-y-0.5">
                        {lastReport.trace.map((entry, i) => (
                          <p
                            key={i}
                            className={`text-[10px] font-mono leading-snug break-all ${
                              entry.level === 'error' ? 'text-destructive' :
                              entry.level === 'warn' ? 'text-yellow-500' :
                              entry.level === 'success' ? 'text-green-500' :
                              'text-muted-foreground'
                            }`}
                          >
                            <span className="opacity-60">[{entry.step}]</span> {entry.message}
                            {entry.data && Object.keys(entry.data).length > 0 && (
                              <span className="opacity-60"> · {JSON.stringify(entry.data)}</span>
                            )}
                          </p>
                        ))}
                      </div>
                    )}
                    {lastReport.replayDetails && lastReport.replayDetails.length > 0 && (
                      <details className="text-[10px]">
                        <summary className="cursor-pointer text-muted-foreground">
                          Détails messages ({lastReport.replayDetails.length})
                        </summary>
                        <div className="mt-1 max-h-40 overflow-auto space-y-0.5 font-mono">
                          {lastReport.replayDetails.map((d, i) => (
                            <p
                              key={i}
                              className={
                                d.outcome === 'recovered' ? 'text-green-500' :
                                d.outcome === 'failed' ? 'text-destructive' :
                                'text-muted-foreground'
                              }
                            >
                              {d.outcome === 'recovered' ? '✓' : d.outcome === 'failed' ? '✕' : '○'} {d.messageId.slice(0, 8)} · {d.bodyKind ?? 'plain'} · {d.durationMs}ms
                              {d.error && <span className="opacity-80"> — {d.error}</span>}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                    <Button
                      onClick={copyDiagReport}
                      size="sm"
                      variant="ghost"
                      className="w-full h-7 gap-1 text-[10px]"
                    >
                      <Copy className="h-3 w-3" /> Copier le rapport JSON
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Info */}
            <div className="p-3 bg-primary/5 rounded-lg space-y-1">
              <p className="text-xs font-medium flex items-center gap-1">
                <Cloud className="h-3 w-3 text-primary" /> Comment ça marche ?
              </p>
              <ul className="text-[10px] text-muted-foreground space-y-1 list-disc pl-4">
                <li>Tes clés sont chiffrées avec un dérivé de ton mot de passe (jamais stocké en clair)</li>
                <li>À chaque connexion, tes clés sont restaurées automatiquement si absentes localement</li>
                <li>Les modifications de clés sont synchronisées en arrière-plan</li>
                <li>Si tu changes ton mot de passe, la sauvegarde sera mise à jour à la prochaine connexion</li>
              </ul>
            </div>
          </TabsContent>

          <TabsContent value="device" className="space-y-3 mt-3">
            <div className="space-y-2">
              <p className="text-xs font-medium">Nouvel appareil</p>
              <Button
                onClick={handleCreateLink}
                disabled={deviceLink.isLoading}
                size="sm"
                className="w-full gap-1"
              >
                {deviceLink.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <QrCode className="h-3 w-3" />}
                Generer une demande de liaison
              </Button>
              {qrData && (
                <div className="p-3 bg-muted rounded-lg space-y-3">
                  <div className="flex justify-center">
                    <div className="bg-white p-3 rounded-lg">
                      <QRCodeSVG value={qrData} size={180} level="M" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Scanne ce QR depuis un appareil deja connecte, puis reviens ici recuperer les cles.
                  </p>
                  <div className="flex gap-1">
                    <code className="text-[10px] bg-background p-2 rounded flex-1 break-all max-h-16 overflow-auto">
                      {qrData}
                    </code>
                    <Button size="sm" variant="ghost" onClick={copyQrData} className="shrink-0">
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                  <Button
                    onClick={handleClaimLink}
                    disabled={deviceLink.isLoading}
                    size="sm"
                    variant="outline"
                    className="w-full gap-1"
                  >
                    {deviceLink.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    Recuperer les cles approuvees
                  </Button>
                </div>
              )}
            </div>

            <div className="border-t pt-3 space-y-2">
              <p className="text-xs font-medium">Appareil deja connecte</p>
              <Input
                placeholder="Colle ici le QR/code du nouvel appareil"
                value={approvalInput}
                onChange={e => setApprovalInput(e.target.value)}
                className="h-9 text-xs font-mono"
              />
              <Button
                onClick={handleApproveLink}
                disabled={deviceLink.isLoading || !approvalInput.trim()}
                size="sm"
                variant="outline"
                className="w-full gap-1"
              >
                {deviceLink.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Approuver et envoyer le transfert chiffre
              </Button>
              <p className="text-[10px] text-muted-foreground leading-snug">
                L appareil approuve chiffre les cles et le cache d historique pour la cle publique du nouvel appareil. Le serveur ne voit que du ciphertext.
              </p>
            </div>

            <div className="border-t pt-3 space-y-2">
              <p className="text-xs font-medium">Apres rechargement du nouvel appareil</p>
              <Input
                placeholder="Colle le code de liaison si le QR a disparu"
                value={scanInput}
                onChange={e => setScanInput(e.target.value)}
                className="h-9 text-xs font-mono"
              />
              <Button
                onClick={handleClaimLink}
                disabled={deviceLink.isLoading || (!scanInput.trim() && !qrData)}
                size="sm"
                variant="secondary"
                className="w-full gap-1"
              >
                {deviceLink.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                Verifier l approbation
              </Button>
            </div>

            {deviceLink.error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> {deviceLink.error}
              </p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
