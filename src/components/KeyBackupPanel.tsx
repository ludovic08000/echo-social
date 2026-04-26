import { useState, useEffect } from 'react';
import { Shield, QrCode, Download, Upload, Loader2, Check, AlertCircle, Copy, Key, RefreshCw, Cloud, Bug, ChevronDown, ChevronUp } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { useDeviceLink } from '@/hooks/useDeviceLink';
import { isAutoBackupActive, syncBackupToServer, hasLocalKeys } from '@/lib/crypto/accountKeyBackup';
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
  // Device transfer
  const [qrData, setQrData] = useState<string | null>(null);
  const [transferPin, setTransferPin] = useState<string | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [pinInput, setPinInput] = useState('');

  useEffect(() => {
    backup.hasBackup().then(setHasExisting);
    setAutoBackupOn(isAutoBackupActive());
    hasLocalKeys().then(setHasLocal);
  }, []);

  const handleForceSync = async () => {
    setSyncing(true);
    try {
      const ok = await syncBackupToServer();
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
    try {
      const report = await resyncE2EE(user.id);
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
      setHasExisting(true);
    } catch (e) {
      console.error('[resync] failed', e);
      toast.error('Re-sync échoué');
    } finally {
      setResyncing(false);
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
    if (!scanInput.trim()) { toast.error('Colle le code de transfert'); return; }
    if (!pinInput.trim()) { toast.error('Entre le code PIN de vérification'); return; }
    const ok = await deviceLink.claimLink(scanInput, pinInput);
    if (ok) {
      toast.success('Clés transférées avec succès ✅');
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
                  ☁️ Sauvegarde disponible sur le serveur — reconnecte-toi pour restaurer automatiquement
                </p>
              )}

              {!hasLocal && !hasExisting && (
                <p className="text-[10px] text-muted-foreground">
                  ⚠️ Aucune clé locale ni sauvegarde — envoie un premier message chiffré pour générer tes clés
                </p>
              )}
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
                <Button
                  onClick={handleResync}
                  disabled={resyncing || syncing || !user}
                  size="sm"
                  variant="secondary"
                  className="w-full gap-1"
                >
                  {resyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
                  Re-sync clés E2EE après restauration
                </Button>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Republie ton identité, renouvelle les clés à usage unique, invalide les anciens canaux et tente de récupérer les messages illisibles.
                </p>
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
