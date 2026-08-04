/**
 * Écrans d'identité cryptographique affichés avant la messagerie.
 *
 * Invariant : aucune identité n'est créée ou remplacée sans action explicite
 * de l'utilisateur, et un seul écran de récupération/réinitialisation peut
 * être visible à la fois.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Lock, RotateCcw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import {
  inspectAccountCryptoState,
  type AccountCryptoInspection,
} from '@/lib/crypto/accountCryptoState';
import { resetUnrecoverableIdentityWithPassword } from '@/lib/crypto/explicitIdentityReset';
import { initAccountKeySync } from '@/lib/crypto/accountKeyBackup';
import { restoreAegisRecoveryVault } from '@/lib/crypto/aegisRecoveryVault';
import {
  acquireRecoveryDialog,
  releaseRecoveryDialog,
} from '@/lib/crypto/recoveryDialogCoordinator';

export const IDENTITY_GATE_OWNER = 'messaging-identity-gate';

export interface AccountCryptoGate {
  loaded: boolean;
  inspection: AccountCryptoInspection | null;
  refresh: () => Promise<void>;
}

/** Inspecte l'état cryptographique du compte connecté (lecture seule). */
export function useAccountCryptoGate(): AccountCryptoGate {
  const { user } = useAuth();
  const [loaded, setLoaded] = useState(false);
  const [inspection, setInspection] = useState<AccountCryptoInspection | null>(null);
  const running = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!user?.id) { setInspection(null); setLoaded(true); return; }
    // Une inspection déjà lancée ne peut pas servir de réponse à une demande
    // postérieure (ex. après un reset) : on enchaîne une nouvelle passe.
    if (running.current) {
      const chained = running.current.then(() => refresh());
      return chained;
    }
    const attempt = (async () => {
      const result = await inspectAccountCryptoState(user.id);
      setInspection(result);
      setLoaded(true);
    })().finally(() => { running.current = null; });
    running.current = attempt;
    return attempt;
  }, [user?.id]);

  useEffect(() => {
    void refresh();
    const onRestored = () => { void refresh(); };
    window.addEventListener('forsure-keys-restored', onRestored);
    window.addEventListener('forsure-keys-unlocked', onRestored);
    return () => {
      window.removeEventListener('forsure-keys-restored', onRestored);
      window.removeEventListener('forsure-keys-unlocked', onRestored);
    };
  }, [refresh]);

  return { loaded, inspection, refresh };
}

/** Prend le verrou d'affichage tant que l'écran est monté. */
function useExclusiveRecoveryScreen(active: boolean) {
  useEffect(() => {
    if (!active) return;
    acquireRecoveryDialog(IDENTITY_GATE_OWNER);
    return () => releaseRecoveryDialog(IDENTITY_GATE_OWNER);
  }, [active]);
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[50vh] px-4 py-8">
      <div className="w-full max-w-sm space-y-4">{children}</div>
    </div>
  );
}

// ─── UNRECOVERABLE_SERVER_IDENTITY ───

export function IdentityResetScreen({
  onSuccess,
  onRetryRestore,
}: {
  onSuccess: () => void;
  onRetryRestore: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [password, setPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useExclusiveRecoveryScreen(true);

  const submit = async () => {
    if (busyRef.current) return;
    if (!password || !acknowledged) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await resetUnrecoverableIdentityWithPassword(password);
      if (result.ok) {
        setPassword('');
        onSuccess();
        return;
      }
      setError(result.message ?? 'Réinitialisation impossible.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <ShieldAlert className="w-7 h-7 text-destructive" />
        </div>
        <h2 className="text-lg font-bold tracking-tight">
          Votre identité sécurisée doit être réinitialisée
        </h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Une identité cryptographique existe déjà pour ce compte, mais sa clé privée et sa
          sauvegarde ne sont plus disponibles. Vous pouvez créer une nouvelle identité après
          confirmation de votre mot de passe. Votre empreinte de sécurité changera et vos contacts
          pourront recevoir une alerte.
        </p>
      </div>

      {!showForm ? (
        <div className="space-y-2">
          <Button className="w-full" onClick={() => setShowForm(true)}>
            Créer une nouvelle identité sécurisée
          </Button>
          <Button variant="ghost" className="w-full" onClick={onRetryRestore}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Réessayer la restauration
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Label htmlFor="identity-reset-password">Mot de passe du compte</Label>
          <Input
            id="identity-reset-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
          />
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              id="identity-reset-ack"
              checked={acknowledged}
              disabled={busy}
              onCheckedChange={(value) => setAcknowledged(value === true)}
            />
            <span>Je comprends que mon empreinte de sécurité va changer.</span>
          </label>

          {error && (
            <p role="alert" className="text-xs font-medium text-destructive">{error}</p>
          )}

          <Button
            className="w-full"
            onClick={submit}
            disabled={busy || !password || !acknowledged}
          >
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Créer une nouvelle identité sécurisée
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={onRetryRestore}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Réessayer la restauration
          </Button>
        </div>
      )}
    </Shell>
  );
}

// ─── RESTORABLE_IDENTITY ───

export function IdentityRestoreScreen({ onRestored }: { onRestored: () => void }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<'password' | 'recovery'>('password');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useExclusiveRecoveryScreen(true);

  const withBusy = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await fn(); } finally { setBusy(false); }
  };

  const restoreWithPassword = () => withBusy(async () => {
    if (!user?.id) return;
    const status = await initAccountKeySync(password, user.id);
    if (status === 'restored' || status === 'local_ok') { setPassword(''); onRestored(); return; }
    setError(status === 'no_backup'
      ? 'Aucune sauvegarde trouvée pour ce compte.'
      : 'Mot de passe incorrect ou sauvegarde illisible.');
  });

  const restoreWithKey = () => withBusy(async () => {
    if (!user?.id) return;
    const result = await restoreAegisRecoveryVault(user.id, recoveryKey.trim());
    if (result.status === 'restored' || result.status === 'already_present') {
      setRecoveryKey('');
      onRestored();
      return;
    }
    setError(result.status === 'not_found'
      ? 'Aucun coffre de récupération trouvé.'
      : 'Clé de récupération invalide ou coffre illisible.');
  });

  return (
    <Shell>
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Lock className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-lg font-bold tracking-tight">Restaurer votre identité sécurisée</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Une sauvegarde de votre identité existe. Restaurez-la avec votre mot de passe ou votre
          clé de récupération : elle ne peut pas être remplacée.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="password"><Lock className="w-4 h-4 mr-1" /> Mot de passe</TabsTrigger>
          <TabsTrigger value="recovery"><KeyRound className="w-4 h-4 mr-1" /> Clé</TabsTrigger>
        </TabsList>

        <TabsContent value="password" className="space-y-3 pt-3">
          <Label htmlFor="identity-restore-password">Mot de passe du compte</Label>
          <Input
            id="identity-restore-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button className="w-full" disabled={busy || !password} onClick={restoreWithPassword}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Déverrouiller
          </Button>
        </TabsContent>

        <TabsContent value="recovery" className="space-y-3 pt-3">
          <Label htmlFor="identity-restore-key">Clé de récupération</Label>
          <Input
            id="identity-restore-key"
            value={recoveryKey}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setRecoveryKey(event.target.value)}
          />
          <Button className="w-full" disabled={busy || !recoveryKey.trim()} onClick={restoreWithKey}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Restaurer avec la clé
          </Button>
        </TabsContent>
      </Tabs>

      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </Shell>
  );
}

// ─── INCONSISTENT ───

export function IdentityInconsistentScreen({
  reason,
  onRetry,
}: {
  reason: string;
  onRetry: () => void;
}) {
  useExclusiveRecoveryScreen(true);
  return (
    <Shell>
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <AlertTriangle className="w-7 h-7 text-destructive" />
        </div>
        <h2 className="text-lg font-bold tracking-tight">État cryptographique incohérent</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Par sécurité, la messagerie reste verrouillée et aucune clé ne sera créée.
          Code technique : <span className="font-mono">{reason}</span>
        </p>
        <Button variant="outline" className="w-full" onClick={onRetry}>
          <RotateCcw className="w-4 h-4 mr-2" />
          Réessayer
        </Button>
      </div>
    </Shell>
  );
}
