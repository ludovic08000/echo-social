import { useEffect, useState } from 'react';
import { Cloud, Loader2, RefreshCw, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { hasLocalKeys, isAutoBackupActive, syncBackupToServer } from '@/lib/crypto/accountKeyBackup';
import { toast } from 'sonner';
import { AegisRecoveryKeySection } from '@/components/AegisRecoveryKeySection';

export function KeyBackupPanel() {
  const backup = useSecureBackup();
  const [hasExisting, setHasExisting] = useState(false);
  const [autoBackupOn, setAutoBackupOn] = useState(false);
  const [hasLocal, setHasLocal] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    void backup.hasBackup().then(setHasExisting);
    setAutoBackupOn(isAutoBackupActive());
    void hasLocalKeys().then(setHasLocal);
  }, [backup]);

  const handleForceSync = async () => {
    setSyncing(true);
    try {
      const ok = await syncBackupToServer();
      if (ok) {
        toast.success('Clés synchronisées avec le serveur ✅');
        setHasExisting(true);
      } else {
        toast.error('Aucune clé locale à sauvegarder (déverrouille le PIN si demandé).');
      }
    } catch {
      toast.error('Échec de la synchronisation');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Shield className="h-4 w-4 text-primary" />
          Coffre E2EE — Sauvegarde
        </CardTitle>
        <CardDescription className="text-xs">
          Tes clés de chiffrement sont automatiquement sauvegardées avec ton compte. Si tu changes d&apos;appareil ou vides ton cache, elles seront restaurées à la connexion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${autoBackupOn ? 'bg-green-500' : 'bg-yellow-500'}`} />
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
              ☁️ Sauvegarde disponible — reconnecte-toi pour restaurer les clés après déverrouillage
            </p>
          )}

          {!hasLocal && !hasExisting && (
            <p className="text-[10px] text-muted-foreground">
              ⚠️ Aucune clé locale ni sauvegarde disponible
            </p>
          )}
        </div>

        {hasLocal && autoBackupOn && (
          <Button
            onClick={handleForceSync}
            disabled={syncing}
            size="sm"
            variant="outline"
            className="w-full gap-1"
          >
            {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Forcer la sauvegarde maintenant
          </Button>
        )}

        <AegisRecoveryKeySection />

        <div className="space-y-1 rounded-lg bg-primary/5 p-3">
          <p className="flex items-center gap-1 text-xs font-medium">
            <Cloud className="h-3 w-3 text-primary" /> Comment ça marche ?
          </p>
          <ul className="list-disc space-y-1 pl-4 text-[10px] text-muted-foreground">
            <li>Tes clés sont chiffrées avant leur sauvegarde ; le secret de déverrouillage n&apos;est pas stocké en clair.</li>
            <li>La restauration du coffre intervient uniquement après le déverrouillage prévu par le flow de sécurité.</li>
            <li>L&apos;ajout d&apos;un appareil passe uniquement par l&apos;écran d&apos;approbation d&apos;appareil, sans QR pour le moment.</li>
            <li>La sauvegarde ne crée, ne récupère et n&apos;approuve jamais un DeviceID.</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
