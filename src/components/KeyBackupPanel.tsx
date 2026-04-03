import { useState, useEffect } from 'react';
import { Shield, QrCode, Download, Upload, Loader2, Check, AlertCircle, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { useDeviceLink } from '@/hooks/useDeviceLink';
import { useAutoBackup } from '@/hooks/useAutoBackup';
import { toast } from 'sonner';

export function KeyBackupPanel() {
  const backup = useSecureBackup();
  const deviceLink = useDeviceLink();
  const autoBackup = useAutoBackup();
  const [password, setPassword] = useState('');
  const [hasExisting, setHasExisting] = useState(false);
  const [qrData, setQrData] = useState<string | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    backup.hasBackup().then(setHasExisting);
  }, []);

  const handleBackup = async () => {
    if (password.length < 8) {
      toast.error('Mot de passe trop court (min. 8 caractères)');
      return;
    }
    const ok = await backup.createBackup(password);
    if (ok) {
      autoBackup.setBackupPassword(password);
      toast.success('Sauvegarde chiffrée créée ✅');
      setHasExisting(true);
      setDone(true);
    } else {
      toast.error(backup.error || 'Échec de la sauvegarde');
    }
  };

  const handleRestore = async () => {
    if (!password) {
      toast.error('Entre ton mot de passe de sauvegarde');
      return;
    }
    const ok = await backup.restoreBackup(password);
    if (ok) {
      toast.success('Clés restaurées avec succès ✅');
      setDone(true);
    } else {
      toast.error(backup.error || 'Échec de la restauration');
    }
  };

  const handleCreateLink = async () => {
    const result = await deviceLink.createLink();
    if (result) {
      setQrData(result.qrData);
      toast.success('Lien de transfert créé (expire dans 5 min)');
    } else {
      toast.error(deviceLink.error || 'Erreur');
    }
  };

  const handleClaimLink = async () => {
    if (!scanInput.trim()) {
      toast.error('Colle le code QR scanné');
      return;
    }
    const ok = await deviceLink.claimLink(scanInput);
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
          Sauvegarde & Transfert de clés E2EE
        </CardTitle>
        <CardDescription className="text-xs">
          Protège tes messages chiffrés en sauvegardant tes clés ou en les transférant vers un autre appareil.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="backup" className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-8">
            <TabsTrigger value="backup" className="text-xs gap-1">
              <Download className="h-3 w-3" /> Sauvegarde
            </TabsTrigger>
            <TabsTrigger value="device" className="text-xs gap-1">
              <QrCode className="h-3 w-3" /> Transfert
            </TabsTrigger>
          </TabsList>

          <TabsContent value="backup" className="space-y-3 mt-3">
            <Input
              type="password"
              placeholder="Mot de passe de sauvegarde (min. 8 car.)"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="h-9 text-sm"
            />
            <div className="flex gap-2">
              <Button
                onClick={handleBackup}
                disabled={backup.isLoading || password.length < 8}
                size="sm"
                className="flex-1 gap-1"
              >
                {backup.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                {hasExisting ? 'Mettre à jour' : 'Sauvegarder'}
              </Button>
              {hasExisting && (
                <Button
                  onClick={handleRestore}
                  disabled={backup.isLoading || !password}
                  size="sm"
                  variant="outline"
                  className="flex-1 gap-1"
                >
                  {backup.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  Restaurer
                </Button>
              )}
            </div>
            {done && (
              <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="h-3 w-3" /> Opération réussie
              </p>
            )}
            {autoBackup.hasPassword && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" /> Sauvegarde automatique activée
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
                <div className="p-3 bg-muted rounded-lg space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Copie ce code et colle-le sur ton nouvel appareil (expire dans 5 min) :
                  </p>
                  <div className="flex gap-1">
                    <code className="text-[10px] bg-background p-2 rounded flex-1 break-all max-h-20 overflow-auto">
                      {qrData}
                    </code>
                    <Button size="sm" variant="ghost" onClick={copyQrData} className="shrink-0">
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
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
              <Button
                onClick={handleClaimLink}
                disabled={deviceLink.isLoading || !scanInput.trim()}
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
