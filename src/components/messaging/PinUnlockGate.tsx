import { useState, type ReactNode } from 'react';
import { KeyRound, Loader2, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChatPin } from '@/hooks/useChatPin';
import { PinValidatedMessaging } from '@/components/PinValidatedMessaging';
import {
  IdentityInconsistentScreen,
  IdentityResetScreen,
  IdentityRestoreScreen,
  useAccountCryptoGate,
} from '@/components/messaging/IdentityRecoveryGate';
import { cn } from '@/lib/utils';

interface PinUnlockGateProps {
  children: ReactNode;
  compact?: boolean;
}

export function PinUnlockGate({ children, compact = false }: PinUnlockGateProps) {
  const pin = useChatPin();
  const crypto = useAccountCryptoGate();
  const [value, setValue] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [resetMode, setResetMode] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!pin.loaded || !crypto.loaded) {
    return (
      <div className={cn('flex items-center justify-center', compact ? 'h-full py-6' : 'min-h-[50vh]')}>
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  const identityState = crypto.inspection?.state;
  if (identityState === 'INCONSISTENT') {
    return (
      <IdentityInconsistentScreen
        reason={crypto.inspection?.reason ?? 'unknown'}
        onRetry={() => { void crypto.refresh(); }}
      />
    );
  }
  if (identityState === 'RESTORABLE_IDENTITY') {
    return <IdentityRestoreScreen onRestored={() => { void crypto.refresh(); }} />;
  }
  if (identityState === 'UNRECOVERABLE_SERVER_IDENTITY') {
    return (
      <IdentityResetScreen
        onSuccess={() => { void crypto.refresh(); }}
        onRetryRestore={() => { void crypto.refresh(); }}
      />
    );
  }

  // A remote PIN continuity envelope cannot be opened without the account
  // Master Key. Showing the PIN field in this state is a dead end: the PIN
  // verifier itself is still sealed. Route through account recovery first;
  // once the Master Key is restored, useChatPin receives the restoration event,
  // restores the local verifier, and the normal PIN gate becomes usable.
  const pinContinuityLocked = pin.error?.startsWith('Votre PIN existe toujours.') === true;
  if (pinContinuityLocked) {
    return (
      <IdentityRestoreScreen
        onRestored={() => {
          window.dispatchEvent(new CustomEvent('forsure-keys-restored'));
          void crypto.refresh();
        }}
      />
    );
  }

  if (pin.unlocked) return <PinValidatedMessaging>{children}</PinValidatedMessaging>;

  const submit = async () => {
    setLocalError(null);
    if (!/^\d{6}$/.test(value)) {
      setLocalError('Le PIN doit contenir exactement 6 chiffres.');
      return;
    }

    if (!pin.hasPin) {
      if (confirmation !== value) {
        setLocalError('Les deux PIN ne correspondent pas.');
        return;
      }
      const ok = await pin.setupPin(value);
      if (ok) {
        setValue('');
        setConfirmation('');
      }
      return;
    }

    const ok = await pin.verifyPin(value);
    if (ok) setValue('');
  };

  const requestReset = async () => {
    setLocalError(null);
    const ok = await pin.requestReset();
    if (ok) setResetSent(true);
  };

  const confirmReset = async () => {
    setLocalError(null);
    if (!resetCode.trim()) {
      setLocalError('Saisissez le code reçu par email.');
      return;
    }
    const ok = await pin.confirmReset(resetCode.trim());
    if (ok) {
      setResetMode(false);
      setResetSent(false);
      setResetCode('');
      setValue('');
      setConfirmation('');
    }
  };

  const error = localError ?? pin.error;

  return (
    <div className={cn(
      'flex h-full items-center justify-center overflow-y-auto bg-background',
      compact ? 'px-3 py-4' : 'min-h-[50vh] px-4 py-8',
    )}>
      <div className={cn('w-full', compact ? 'max-w-full' : 'max-w-sm')}>
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            {pin.hasPin ? <LockKeyhole className="h-5 w-5 text-primary" /> : <KeyRound className="h-5 w-5 text-primary" />}
          </div>
          <h2 className="text-base font-semibold">
            {resetMode ? 'Réinitialiser le PIN' : pin.hasPin ? 'Déverrouiller la messagerie' : 'Créer le PIN de messagerie'}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {resetMode
              ? 'La réinitialisation passe par le mécanisme de récupération sécurisé du compte.'
              : 'Le PIN local protège l’accès aux clés de messagerie sur cet appareil.'}
          </p>
        </div>

        {resetMode ? (
          <div className="space-y-3">
            {!resetSent ? (
              <Button className="w-full" disabled={pin.processing} onClick={() => void requestReset()}>
                {pin.processing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Envoyer le code de récupération
              </Button>
            ) : (
              <>
                <Input
                  value={resetCode}
                  onChange={(event) => setResetCode(event.target.value)}
                  placeholder="Code reçu par email"
                  autoComplete="one-time-code"
                />
                <Button className="w-full" disabled={pin.processing} onClick={() => void confirmReset()}>
                  {pin.processing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirmer la réinitialisation
                </Button>
              </>
            )}
            <Button variant="ghost" className="w-full" onClick={() => setResetMode(false)}>
              Retour
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value.replace(/\D/g, '').slice(0, 6))}
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="PIN à 6 chiffres"
              maxLength={6}
            />

            {!pin.hasPin && (
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, '').slice(0, 6))}
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Confirmer le PIN"
                maxLength={6}
              />
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={pin.processing} onClick={() => void submit()}>
              {pin.processing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pin.hasPin ? 'Déverrouiller' : 'Créer le PIN'}
            </Button>

            {pin.hasPin && (
              <Button variant="ghost" className="w-full" onClick={() => setResetMode(true)}>
                PIN oublié
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
