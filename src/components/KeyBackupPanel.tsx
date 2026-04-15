import { useState, useEffect } from 'react';
import { Shield, QrCode, Download, Upload, Loader2, Check, AlertCircle, Copy, Key, RefreshCw } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { useDeviceLink } from '@/hooks/useDeviceLink';
import { useAutoBackup } from '@/hooks/useAutoBackup';
import { formatRecoveryKey, normalizeRecoveryKey, isValidRecoveryKey } from '@/lib/crypto/recoveryKey';
import { toast } from 'sonner';

export function KeyBackupPanel() {
  const backup = useSecureBackup();
  const deviceLink = useDeviceLink();
  const autoBackup = useAutoBackup();
  const [hasExisting, setHasExisting] = useState(false);
  // Recovery key shown after backup creation — user MUST save it
  const [displayedRecoveryKey, setDisplayedRecoveryKey] = useState<string | null>(null);
  const [recoveryKeySaved, setRecoveryKeySaved] = useState(false);
  // Restore input
  const [restoreKeyInput, setRestoreKeyInput] = useState('');
  const [done, setDone] = useState(false);
  // Device transfer
  const [qrData, setQrData] = useState<string | null>(null);
  const [transferPin, setTransferPin] = useState<string | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [pinInput, setPinInput] = useState('');

  useEffect(() => {
    backup.hasBackup().then(setHasExisting);
  }, []);

  const handleCreateBackup = async () => {
    const recoveryKey = await backup.createBackup();
    if (recoveryKey) {
      setDisplayedRecoveryKey(recoveryKey);
      setRecoveryKeySaved(false);
      // Store normalized key in auto-backup memory (volatile)
      autoBackup.setRecoveryKey(normalizeRecoveryKey(recoveryKey));
      setHasExisting(true);
      toast.success('Coffre chiffré créé ✅');
    } else {
      toast.error(backup.error || 'Échec de la sauvegarde');
    }
  };

  const handleCopyRecoveryKey = () => {
    if (displayedRecoveryKey) {
      navigator.clipboard.writeText(displayedRecoveryKey);
      toast.success('Clé copiée dans le presse-papier');
      setRecoveryKeySaved(true);
    }
  };

  const handleDismissRecoveryKey = () => {
    setDisplayedRecoveryKey(null);
    setDone(true);
  };

  const handleRestore = async () => {
    const normalized = normalizeRecoveryKey(restoreKeyInput);
    if (!isValidRecoveryKey(restoreKeyInput)) {
      toast.error('Clé de récupération invalide (32 caractères attendus)');
      return;
    }
    const ok = await backup.restoreBackup(normalized);
    if (ok) {
      toast.success('Identité et clés restaurées ✅');
      setDone(true);
      setRestoreKeyInput('');
      // Enable auto-backup with the restored key
      autoBackup.setRecoveryKey(normalized);
    } else {
      toast.error(backup.error || 'Échec — clé incorrecte ou backup corrompu');
    }
  };

  const handleCreateLink = async () => {
    const result = await deviceLink.createLink();
    if (result) {
      setQrData(result.qrData);
      setTransferPin(result.pin);
      toast.success('Lien de transfert créé (expire dans 5 min)');
    } else {
      toast.error(deviceLink.error || 'Erreur');
    }
  };

  const handleClaimLink = async () => {
    if (!scanInput.trim()) {
      toast.error('Colle le code de transfert');
      return;
    }
    if (!pinInput.trim()) {
      toast.error('Entre le code PIN de vérification');
      return;
    }
    const ok = await deviceLink.claimLink(scanInput, pinInput);
    if (ok) {
      toast.success('Clés transférées avec succès ✅');
      setDone(true);
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
          Sauvegarde chiffrée de tes clés avec une clé de récupération unique. Sans elle, tes messages chiffrés seront irrécupérables.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="backup" className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-8">
            <TabsTrigger value="backup" className="text-xs gap-1">
              <Key className="h-3 w-3" /> Sauvegarde
            </TabsTrigger>
            <TabsTrigger value="device" className="text-xs gap-1">
              <QrCode className="h-3 w-3" /> Transfert
            </TabsTrigger>
          </TabsList>

          <TabsContent value="backup" className="space-y-3 mt-3">
            {/* Recovery key display (shown only after creation) */}
            {displayedRecoveryKey && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg space-y-2">
                <p className="text-xs font-bold text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  SAUVEGARDE CETTE CLÉ — Elle ne sera plus jamais affichée
                </p>
                <code className="block text-center text-sm font-bold tracking-[0.15em] bg-background p-3 rounded select-all break-all">
                  {displayedRecoveryKey}
                </code>
                <p className="text-[10px] text-muted-foreground">
                  Note-la sur papier ou dans un gestionnaire de mots de passe. Si tu perds cette clé et ton cache navigateur, 
                  tes messages chiffrés seront définitivement perdus.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={handleCopyRecoveryKey} className="flex-1 gap-1">
                    <Copy className="h-3 w-3" /> Copier
                  </Button>
                  <Button
                    size="sm"
                    variant={recoveryKeySaved ? 'default' : 'ghost'}
                    onClick={handleDismissRecoveryKey}
                    disabled={!recoveryKeySaved}
                    className="flex-1 gap-1"
                  >
                    <Check className="h-3 w-3" /> {recoveryKeySaved ? 'J\'ai noté ma clé' : 'Copie d\'abord'}
                  </Button>
                </div>
              </div>
            )}

            {/* Create / Update backup */}
            {!displayedRecoveryKey && (
              <div className="space-y-2">
                <Button
                  onClick={handleCreateBackup}
                  disabled={backup.isLoading}
                  size="sm"
                  className="w-full gap-1"
                >
                  {backup.isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : hasExisting ? (
                    <RefreshCw className="h-3 w-3" />
                  ) : (
                    <Upload className="h-3 w-3" />
                  )}
                  {hasExisting ? 'Régénérer une nouvelle clé de récupération' : 'Créer un coffre chiffré'}
                </Button>
                {hasExisting && (
                  <p className="text-[10px] text-muted-foreground text-center">
                    ⚠️ Régénérer remplacera l'ancienne clé — l'ancienne ne fonctionnera plus.
                  </p>
                )}
              </div>
            )}

            {/* Restore section */}
            {hasExisting && !displayedRecoveryKey && (
              <div className="border-t pt-3 space-y-2">
                <p className="text-xs font-medium">Restaurer depuis le coffre</p>
                <Input
                  type="text"
                  placeholder="ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789"
                  value={restoreKeyInput}
                  onChange={e => setRestoreKeyInput(e.target.value.toUpperCase())}
                  className="h-9 text-xs font-mono tracking-wider text-center"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button
                  onClick={handleRestore}
                  disabled={backup.isLoading || !restoreKeyInput.trim()}
                  size="sm"
                  variant="outline"
                  className="w-full gap-1"
                >
                  {backup.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  Restaurer mes clés
                </Button>
              </div>
            )}

            {done && !displayedRecoveryKey && (
              <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="h-3 w-3" /> Opération réussie
              </p>
            )}
            {autoBackup.hasKey && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" /> Sauvegarde automatique activée pour cette session
              </p>
            )}
          </TabsContent>

          <TabsContent value="device" className="space-y-3 mt-3">
            <div className="space-y-2">
              <p className="text-xs font-medium">Depuis cet appareil → Nouvel appareil</p>
              <Button
                onClick={handleCreateLink}
                disabled={deviceLink.isLoading}
                size="sm"
                className="w-full gap-1"
              >
                {deviceLink.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <QrCode className="h-3 w-3" />}
                Générer un lien de transfert
              </Button>
              {qrData && (
                <div className="p-3 bg-muted rounded-lg space-y-3">
                  <div className="flex justify-center">
                    <div className="bg-white p-3 rounded-lg">
                      <QRCodeSVG value={qrData} size={180} level="M" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Scanne ce QR ou copie le code ci-dessous (expire dans 5 min)
                  </p>
                  <div className="flex gap-1">
                    <code className="text-[10px] bg-background p-2 rounded flex-1 break-all max-h-16 overflow-auto">
                      {qrData}
                    </code>
                    <Button size="sm" variant="ghost" onClick={copyQrData} className="shrink-0">
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                  {transferPin && (
                    <div className="border-t pt-2 space-y-1">
                      <p className="text-xs font-medium flex items-center gap-1">
                        <Key className="h-3 w-3 text-primary" /> Code PIN de vérification
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Communique ce code séparément (oral, SMS…) — il est nécessaire pour déchiffrer.
                      </p>
                      <code className="block text-center text-lg font-bold tracking-[0.3em] bg-background p-2 rounded select-all">
                        {transferPin}
                      </code>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="border-t pt-3 space-y-2">
              <p className="text-xs font-medium">Sur le nouvel appareil</p>
              <Input
                placeholder="Colle le code de transfert ici"
                value={scanInput}
                onChange={e => setScanInput(e.target.value)}
                className="h-9 text-xs font-mono"
              />
              <Input
                placeholder="Code PIN de vérification"
                value={pinInput}
                onChange={e => setPinInput(e.target.value)}
                className="h-9 text-xs font-mono tracking-widest text-center"
                maxLength={8}
              />
              <Button
                onClick={handleClaimLink}
                disabled={deviceLink.isLoading || !scanInput.trim() || !pinInput.trim()}
                size="sm"
                variant="outline"
                className="w-full gap-1"
              >
                {deviceLink.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                Récupérer les clés
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
