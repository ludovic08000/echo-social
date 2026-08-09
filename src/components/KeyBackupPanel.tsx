import { useState, useEffect } from 'react';
import { Shield, Loader2, RefreshCw, Cloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useSecureBackup } from '@/hooks/useSecureBackup';
import { isAutoBackupActive, syncBackupToServer, hasLocalKeys } from '@/lib/crypto/accountKeyBackup';
import { toast } from 'sonner';
import { AegisRecoveryKeySection } from '@/components/AegisRecoveryKeySection';

export function KeyBackupPanel() {
  const backup = useSecureBackup();
  const [hasExisting, setHasExisting] = useState(false);
  const [autoBackupOn, setAutoBackupOn] = useState(false);
  const [hasLocal, setHasLocal] = useState(false);
  const [syncing, setSyncing] = useState(false);

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
          Tes clés de chiffrement sont automatiquement sauvegardées avec ton compte. Si tu changes d'appareil ou vides ton cache, elles seront restaurées à la connexion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
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

        {hasLocal && autoBackupOn && (
          <Button
            onClick={handleForceSync}
            disabled={syncing}
            size="sm"
            variant="outline"
            className="w-full gap-1"
          >
            {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Forcer la synchronisation maintenant
          </Button>
        )}

        <AegisRecoveryKeySection />

        <div className="p-3 bg-primary/5 rounded-lg space-y-1">
          <p className="text-xs font-medium flex items-center gap-1">
            <Cloud className="h-3 w-3 text-primary" /> Comment ça marche ?
          </p>
          <ul className="text-[10px] text-muted-foreground space-y-1 list-disc pl-4">
            <li>Tes clés sont chiffrées avec un dérivé de ton mot de passe (jamais stocké en clair)</li>
            <li>À chaque connexion, tes clés sont restaurées automatiquement si absentes localement</li>
            <li>L'ajout d'un nouvel appareil passe par l'écran d'approbation d'appareil, sans QR</li>
            <li>Si tu changes ton mot de passe, la sauvegarde sera mise à jour à la prochaine connexion</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
