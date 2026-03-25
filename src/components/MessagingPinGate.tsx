/**
 * MessagingPinGate — Blocks access to messaging until PIN is verified.
 * 
 * First visit: PIN setup (6 digits)
 * Subsequent sessions: PIN entry to unlock
 * PIN is cryptographically tied to E2EE key decryption.
 */

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Lock, Shield, ShieldCheck, Eye, EyeOff, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatPin } from '@/hooks/useChatPin';
import { cn } from '@/lib/utils';

interface MessagingPinGateProps {
  children: ReactNode;
}

export function MessagingPinGate({ children }: MessagingPinGateProps) {
  const pin = useChatPin();

  // Loading state
  if (!pin.loaded) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <div className="w-8 h-8 rounded-full border-3 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  // Unlocked — render children
  if (pin.unlocked) {
    return <>{children}</>;
  }

  // Need to setup or verify PIN
  if (!pin.hasPin) {
    return <PinSetupScreen onSetup={pin.setupPin} processing={pin.processing} error={pin.error} />;
  }

  return <PinEntryScreen onVerify={pin.verifyPin} processing={pin.processing} error={pin.error} />;
}

// ─── PIN Setup Screen ───

function PinSetupScreen({ onSetup, processing, error }: {
  onSetup: (pin: string) => Promise<boolean>;
  processing: boolean;
  error: string | null;
}) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'create' | 'confirm'>('create');
  const [showPin, setShowPin] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleDigit = (digit: string, index: number) => {
    const current = step === 'create' ? pin : confirmPin;
    const setter = step === 'create' ? setPin : setConfirmPin;

    if (!/^\d$/.test(digit)) return;

    const newVal = current.substring(0, index) + digit + current.substring(index + 1);
    setter(newVal.substring(0, 6));

    // Auto-focus next
    if (index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Backspace') {
      const current = step === 'create' ? pin : confirmPin;
      const setter = step === 'create' ? setPin : setConfirmPin;
      if (current[index]) {
        setter(current.substring(0, index) + current.substring(index + 1));
      } else if (index > 0) {
        inputRefs.current[index - 1]?.focus();
        setter(current.substring(0, index - 1) + current.substring(index));
      }
    }
  };

  const handleNext = async () => {
    setLocalError(null);
    if (step === 'create') {
      if (pin.length !== 6) {
        setLocalError('Entrez 6 chiffres');
        return;
      }
      setStep('confirm');
      setConfirmPin('');
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } else {
      if (confirmPin !== pin) {
        setLocalError('Les PIN ne correspondent pas');
        setConfirmPin('');
        setTimeout(() => inputRefs.current[0]?.focus(), 100);
        return;
      }
      await onSetup(pin);
    }
  };

  const currentPin = step === 'create' ? pin : confirmPin;
  const displayError = localError || error;

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] px-6 py-8">
      <div className="w-full max-w-sm flex flex-col items-center gap-6">
        {/* Icon */}
        <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center">
          <KeyRound className="w-10 h-10 text-primary" />
        </div>

        {/* Title */}
        <div className="text-center space-y-2">
          <h2 className="text-xl font-bold text-foreground">
            {step === 'create' ? 'Créer votre PIN sécurisé' : 'Confirmez votre PIN'}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {step === 'create'
              ? 'Ce code à 6 chiffres protège vos messages chiffrés. Sans lui, personne ne peut lire vos conversations.'
              : 'Ressaisissez votre PIN pour confirmer.'
            }
          </p>
        </div>

        {/* PIN Input */}
        <div className="flex items-center gap-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <input
              key={i}
              ref={el => { inputRefs.current[i] = el; }}
              type={showPin ? 'text' : 'password'}
              inputMode="numeric"
              maxLength={1}
              value={currentPin[i] || ''}
              onChange={e => handleDigit(e.target.value.slice(-1), i)}
              onKeyDown={e => handleKeyDown(e, i)}
              onFocus={e => e.target.select()}
              className={cn(
                'w-12 h-14 text-center text-xl font-bold rounded-xl border-2 outline-none transition-all',
                'bg-background text-foreground',
                currentPin[i]
                  ? 'border-primary shadow-sm shadow-primary/20'
                  : 'border-border focus:border-primary',
              )}
              autoFocus={i === 0}
            />
          ))}
        </div>

        {/* Show/hide toggle */}
        <button
          type="button"
          onClick={() => setShowPin(!showPin)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showPin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showPin ? 'Masquer' : 'Afficher'}
        </button>

        {/* Error */}
        {displayError && (
          <p className="text-sm text-destructive font-medium text-center">{displayError}</p>
        )}

        {/* Action */}
        <Button
          onClick={handleNext}
          disabled={currentPin.length !== 6 || processing}
          className="w-full h-12 rounded-xl text-sm font-semibold"
        >
          {processing ? (
            <div className="w-5 h-5 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
          ) : step === 'create' ? (
            'Continuer'
          ) : (
            <>
              <Shield className="w-4 h-4 mr-2" />
              Activer la protection
            </>
          )}
        </Button>

        {step === 'confirm' && (
          <button
            onClick={() => { setStep('create'); setPin(''); setConfirmPin(''); setLocalError(null); }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Recommencer
          </button>
        )}

        {/* Security notice */}
        <div className="flex items-start gap-2 bg-primary/5 rounded-xl p-3 w-full">
          <Lock className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            <strong className="text-foreground">Important :</strong> Ce PIN ne peut pas être récupéré. 
            Si vous le perdez, vous devrez réinitialiser vos clés de chiffrement et vos anciens messages seront illisibles.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── PIN Entry Screen ───

function PinEntryScreen({ onVerify, processing, error }: {
  onVerify: (pin: string) => Promise<boolean>;
  processing: boolean;
  error: string | null;
}) {
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleDigit = (digit: string, index: number) => {
    if (!/^\d$/.test(digit)) return;
    const newVal = pin.substring(0, index) + digit + pin.substring(index + 1);
    setPin(newVal.substring(0, 6));

    if (index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Backspace') {
      if (pin[index]) {
        setPin(pin.substring(0, index) + pin.substring(index + 1));
      } else if (index > 0) {
        inputRefs.current[index - 1]?.focus();
        setPin(pin.substring(0, index - 1) + pin.substring(index));
      }
    }
  };

  const handleSubmit = async () => {
    if (pin.length !== 6) return;
    const ok = await onVerify(pin);
    if (!ok) {
      setAttempts(a => a + 1);
      setPin('');
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    }
  };

  // Auto-submit when 6 digits entered
  useEffect(() => {
    if (pin.length === 6 && !processing) {
      handleSubmit();
    }
  }, [pin]);

  const isLocked = attempts >= 5;

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] px-6 py-8">
      <div className="w-full max-w-sm flex flex-col items-center gap-6">
        {/* Icon */}
        <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center">
          <ShieldCheck className="w-10 h-10 text-primary" />
        </div>

        {/* Title */}
        <div className="text-center space-y-2">
          <h2 className="text-xl font-bold text-foreground">Déverrouiller la messagerie</h2>
          <p className="text-sm text-muted-foreground">
            Entrez votre PIN à 6 chiffres pour déchiffrer vos conversations.
          </p>
        </div>

        {/* PIN Input */}
        <div className="flex items-center gap-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <input
              key={i}
              ref={el => { inputRefs.current[i] = el; }}
              type={showPin ? 'text' : 'password'}
              inputMode="numeric"
              maxLength={1}
              value={pin[i] || ''}
              onChange={e => handleDigit(e.target.value.slice(-1), i)}
              onKeyDown={e => handleKeyDown(e, i)}
              onFocus={e => e.target.select()}
              disabled={isLocked || processing}
              className={cn(
                'w-12 h-14 text-center text-xl font-bold rounded-xl border-2 outline-none transition-all',
                'bg-background text-foreground',
                isLocked && 'opacity-50 cursor-not-allowed',
                error && !processing
                  ? 'border-destructive animate-shake'
                  : pin[i]
                    ? 'border-primary shadow-sm shadow-primary/20'
                    : 'border-border focus:border-primary',
              )}
              autoFocus={i === 0}
            />
          ))}
        </div>

        {/* Show/hide */}
        <button
          type="button"
          onClick={() => setShowPin(!showPin)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showPin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showPin ? 'Masquer' : 'Afficher'}
        </button>

        {/* Processing */}
        {processing && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            Déchiffrement…
          </div>
        )}

        {/* Error */}
        {error && !processing && (
          <p className="text-sm text-destructive font-medium text-center">
            {error}
            {attempts > 0 && attempts < 5 && (
              <span className="block text-xs mt-1 text-muted-foreground">
                {5 - attempts} tentative{5 - attempts > 1 ? 's' : ''} restante{5 - attempts > 1 ? 's' : ''}
              </span>
            )}
          </p>
        )}

        {/* Locked */}
        {isLocked && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-3 w-full text-center">
            <p className="text-sm text-destructive font-semibold">Trop de tentatives</p>
            <p className="text-xs text-muted-foreground mt-1">Reconnectez-vous pour réessayer.</p>
          </div>
        )}

        {/* Submit button (fallback if auto-submit didn't trigger) */}
        {!processing && pin.length === 6 && !isLocked && (
          <Button
            onClick={handleSubmit}
            className="w-full h-12 rounded-xl text-sm font-semibold"
          >
            <Lock className="w-4 h-4 mr-2" />
            Déverrouiller
          </Button>
        )}
      </div>
    </div>
  );
}
