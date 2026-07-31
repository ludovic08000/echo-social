import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSecureBackup } from '@/hooks/useSecureBackup';

export function AegisRecoveryKeySection() {
  const backup = useSecureBackup();
  const [hasVault, setHasVault] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void backup.hasBackup().then((exists) => {
      if (active) setHasVault(exists);
    });
    return () => {
      active = false;
    };
  }, [backup.hasBackup]);

  const createOrRotate = async () => {
    const created = await backup.createBackup();
    if (!created) {
      toast.error(backup.error ?? 'Impossible de créer le coffre de récupération');
      return;
    }
    setRecoveryKey(created);
    setHasVault(true);
    setCopied(false);
    toast.success(hasVault ? 'Clé de récupération renouvelée' : 'Coffre de récupération créé');
  };

  const copyKey = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    toast.success('Clé copiée');
  };

  return (
    <section className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <KeyRound className="h-4 w-4 text-primary mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">Clé de récupération Aegis</p>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Le coffre contient uniquement l’identité portable du compte. Il ne remplace jamais les
            ratchets, préclés ou secrets d’un appareil déjà configuré.
          </p>
        </div>
      </div>

      {recoveryKey ? (
        <div className="space-y-2">
          <div className="rounded-md border bg-background p-2 font-mono text-[11px] break-all select-all">
            {recoveryKey}
          </div>
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Enregistre cette clé maintenant. Elle ne sera plus affichée. Une rotation invalide
              immédiatement la clé précédente.
            </span>
          </div>
          <Button type="button" size="sm" variant="outline" className="w-full gap-1" onClick={copyKey}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copiée' : 'Copier la clé'}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] text-muted-foreground">
            {hasVault ? 'Un coffre existe déjà.' : 'Aucun coffre de récupération configuré.'}
          </p>
          <Button
            type="button"
            size="sm"
            variant={hasVault ? 'outline' : 'default'}
            disabled={backup.isLoading}
            className="gap-1 shrink-0"
            onClick={createOrRotate}
          >
            {backup.isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : hasVault ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            {hasVault ? 'Renouveler' : 'Créer'}
          </Button>
        </div>
      )}

      {backup.error && !recoveryKey && (
        <p className="text-[10px] text-destructive">{backup.error}</p>
      )}
    </section>
  );
}
