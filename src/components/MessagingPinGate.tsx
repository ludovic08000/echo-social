/**
 * MessagingPinGate — Premium PIN gate for encrypted messaging.
 */

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { Lock, Shield, ShieldCheck, Eye, EyeOff, KeyRound, ArrowLeft, Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatPin } from '@/hooks/useChatPin';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface MessagingPinGateProps {
  children: ReactNode;
}

export function MessagingPinGate({ children }: MessagingPinGateProps) {
  const pin = useChatPin();

  if (!pin.loaded) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Lock className="w-6 h-6 text-primary/60" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground animate-pulse">Chargement sécurisé…</p>
        </motion.div>
      </div>
    );
  }

  if (pin.unlocked) return <>{children}</>;

  if (!pin.hasPin) {
    return <PinSetupScreen onSetup={pin.setupPin} processing={pin.processing} error={pin.error} />;
  }

  return <PinEntryScreen onVerify={pin.verifyPin} processing={pin.processing} error={pin.error} />;
}

// ─── Shared PIN Dot Input ───

function PinDots({
  value,
  length = 6,
  showPin,
  error,
  disabled,
  onDigit,
  onBackspace,
  autoFocus = true,
}: {
  value: string;
  length?: number;
  showPin: boolean;
  error?: boolean;
  disabled?: boolean;
  onDigit: (digit: string, index: number) => void;
  onBackspace: (index: number) => void;
  autoFocus?: boolean;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) {
      setTimeout(() => inputRefs.current[0]?.focus(), 150);
    }
  }, [autoFocus]);

  const focusIndex = (i: number) => {
    setTimeout(() => inputRefs.current[i]?.focus(), 20);
  };

  return (
    <div className="flex items-center justify-center gap-3">
      {Array.from({ length }).map((_, i) => {
        const filled = !!value[i];
        return (
          <motion.div
            key={i}
            initial={false}
            animate={
              error
                ? { x: [0, -6, 6, -4, 4, 0], transition: { duration: 0.4 } }
                : filled
                  ? { scale: [1, 1.15, 1], transition: { duration: 0.15 } }
                  : {}
            }
            className="relative"
          >
            <input
              ref={el => { inputRefs.current[i] = el; }}
              type={showPin ? 'tel' : 'password'}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              value={value[i] || ''}
              disabled={disabled}
              onChange={e => {
                const d = e.target.value.replace(/\D/g, '').slice(-1);
                if (d) {
                  onDigit(d, i);
                  if (i < length - 1) focusIndex(i + 1);
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Backspace') {
                  e.preventDefault();
                  onBackspace(i);
                  if (!value[i] && i > 0) focusIndex(i - 1);
                } else if (e.key === 'ArrowLeft' && i > 0) {
                  focusIndex(i - 1);
                } else if (e.key === 'ArrowRight' && i < length - 1) {
                  focusIndex(i + 1);
                }
              }}
              onFocus={e => e.target.select()}
              className={cn(
                'w-12 h-14 sm:w-14 sm:h-16 text-center text-2xl font-bold rounded-2xl border-2 outline-none',
                'transition-all duration-200 ease-out',
                'bg-card text-foreground caret-primary',
                disabled && 'opacity-40 cursor-not-allowed',
                error
                  ? 'border-destructive bg-destructive/5'
                  : filled
                    ? 'border-primary shadow-lg shadow-primary/15 bg-primary/5'
                    : 'border-border/60 hover:border-border focus:border-primary focus:shadow-md focus:shadow-primary/10',
              )}
              autoComplete="one-time-code"
            />
            {/* Dot indicator below */}
            <div className={cn(
              'absolute -bottom-2 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full transition-all duration-200',
              filled ? 'bg-primary scale-100' : 'bg-border/40 scale-75',
            )} />
          </motion.div>
        );
      })}
    </div>
  );
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

  const currentPin = step === 'create' ? pin : confirmPin;
  const setter = step === 'create' ? setPin : setConfirmPin;
  const displayError = localError || error;

  const handleDigit = useCallback((digit: string, index: number) => {
    setter(prev => {
      const arr = prev.split('');
      arr[index] = digit;
      return arr.join('').substring(0, 6);
    });
    setLocalError(null);
  }, [setter]);

  const handleBackspace = useCallback((index: number) => {
    setter(prev => {
      const arr = prev.split('');
      if (arr[index]) {
        arr[index] = '';
      } else if (index > 0) {
        arr[index - 1] = '';
      }
      return arr.join('');
    });
  }, [setter]);

  const handleNext = async () => {
    setLocalError(null);
    if (step === 'create') {
      if (pin.length !== 6) {
        setLocalError('Entrez 6 chiffres');
        return;
      }
      setStep('confirm');
      setConfirmPin('');
    } else {
      if (confirmPin !== pin) {
        setLocalError('Les PIN ne correspondent pas');
        setConfirmPin('');
        return;
      }
      await onSetup(pin);
    }
  };

  const handleBack = () => {
    setStep('create');
    setPin('');
    setConfirmPin('');
    setLocalError(null);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-md flex flex-col items-center"
      >
        {/* Header icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
          className="relative mb-8"
        >
          <div className="w-24 h-24 rounded-[28px] bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center backdrop-blur-sm border border-primary/10">
            <Fingerprint className="w-12 h-12 text-primary" />
          </div>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.3, type: 'spring' }}
            className="absolute -bottom-1 -right-1 w-8 h-8 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/30"
          >
            <KeyRound className="w-4 h-4 text-primary-foreground" />
          </motion.div>
        </motion.div>

        {/* Title */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: step === 'confirm' ? 20 : -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: step === 'confirm' ? -20 : 20 }}
            transition={{ duration: 0.25 }}
            className="text-center mb-8 space-y-2"
          >
            <h2 className="text-2xl font-bold text-foreground tracking-tight">
              {step === 'create' ? 'Créez votre code PIN' : 'Confirmez votre code'}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
              {step === 'create'
                ? 'Ce code à 6 chiffres protège l'accès à vos conversations chiffrées.'
                : 'Ressaisissez votre code PIN pour confirmer.'}
            </p>
          </motion.div>
        </AnimatePresence>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          <div className={cn(
            'w-8 h-1 rounded-full transition-colors duration-300',
            'bg-primary',
          )} />
          <div className={cn(
            'w-8 h-1 rounded-full transition-colors duration-300',
            step === 'confirm' ? 'bg-primary' : 'bg-border/40',
          )} />
        </div>

        {/* PIN Input */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="mb-6"
          >
            <PinDots
              value={currentPin}
              showPin={showPin}
              error={!!displayError}
              onDigit={handleDigit}
              onBackspace={handleBackspace}
            />
          </motion.div>
        </AnimatePresence>

        {/* Show/hide */}
        <button
          type="button"
          onClick={() => setShowPin(!showPin)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          {showPin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showPin ? 'Masquer le code' : 'Afficher le code'}
        </button>

        {/* Error */}
        <AnimatePresence>
          {displayError && (
            <motion.p
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              className="text-sm text-destructive font-medium text-center mb-4"
            >
              {displayError}
            </motion.p>
          )}
        </AnimatePresence>

        {/* Actions */}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={handleNext}
            disabled={currentPin.length !== 6 || processing}
            className="w-full h-13 rounded-2xl text-sm font-semibold shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 transition-all"
            size="lg"
          >
            {processing ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                <span>Chiffrement…</span>
              </div>
            ) : step === 'create' ? (
              'Continuer'
            ) : (
              <span className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Activer la protection
              </span>
            )}
          </Button>

          {step === 'confirm' && (
            <button
              onClick={handleBack}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Recommencer
            </button>
          )}
        </div>

        {/* Security notice */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-8 flex items-start gap-3 bg-card border border-border/50 rounded-2xl p-4 w-full max-w-xs"
        >
          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Lock className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-0.5">Important</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Ce code ne peut pas être récupéré. Si vous le perdez, vos anciens messages seront illisibles.
            </p>
          </div>
        </motion.div>
      </motion.div>
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
  const submittingRef = useRef(false);

  const handleDigit = useCallback((digit: string, index: number) => {
    setPin(prev => {
      const arr = prev.split('');
      arr[index] = digit;
      return arr.join('').substring(0, 6);
    });
  }, []);

  const handleBackspace = useCallback((index: number) => {
    setPin(prev => {
      const arr = prev.split('');
      if (arr[index]) {
        arr[index] = '';
      } else if (index > 0) {
        arr[index - 1] = '';
      }
      return arr.join('');
    });
  }, []);

  // Auto-submit
  useEffect(() => {
    if (pin.length === 6 && !processing && !submittingRef.current && attempts < 5) {
      submittingRef.current = true;
      onVerify(pin).then(ok => {
        submittingRef.current = false;
        if (!ok) {
          setAttempts(a => a + 1);
          setPin('');
        }
      });
    }
  }, [pin, processing, attempts, onVerify]);

  const isLocked = attempts >= 5;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-md flex flex-col items-center"
      >
        {/* Header */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
          className="relative mb-8"
        >
          <div className={cn(
            'w-24 h-24 rounded-[28px] flex items-center justify-center backdrop-blur-sm border',
            isLocked
              ? 'bg-gradient-to-br from-destructive/20 to-destructive/5 border-destructive/10'
              : 'bg-gradient-to-br from-primary/20 to-primary/5 border-primary/10',
          )}>
            <ShieldCheck className={cn('w-12 h-12', isLocked ? 'text-destructive' : 'text-primary')} />
          </div>
          {processing && (
            <div className="absolute inset-0 rounded-[28px] border-2 border-primary border-t-transparent animate-spin" />
          )}
        </motion.div>

        {/* Title */}
        <div className="text-center mb-8 space-y-2">
          <h2 className="text-2xl font-bold text-foreground tracking-tight">
            {isLocked ? 'Accès bloqué' : 'Entrez votre code PIN'}
          </h2>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">
            {isLocked
              ? 'Trop de tentatives échouées. Reconnectez-vous pour réessayer.'
              : 'Saisissez votre code à 6 chiffres pour déverrouiller vos messages.'}
          </p>
        </div>

        {/* PIN Input */}
        {!isLocked && (
          <div className="mb-6">
            <PinDots
              value={pin}
              showPin={showPin}
              error={!!error && !processing}
              disabled={isLocked || processing}
              onDigit={handleDigit}
              onBackspace={handleBackspace}
            />
          </div>
        )}

        {/* Show/hide */}
        {!isLocked && (
          <button
            type="button"
            onClick={() => setShowPin(!showPin)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            {showPin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showPin ? 'Masquer' : 'Afficher'}
          </button>
        )}

        {/* Processing */}
        <AnimatePresence>
          {processing && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-2.5 text-sm text-muted-foreground mb-4"
            >
              <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <span>Déchiffrement en cours…</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error */}
        <AnimatePresence>
          {error && !processing && !isLocked && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="text-center mb-4"
            >
              <p className="text-sm text-destructive font-medium">{error}</p>
              {attempts > 0 && attempts < 5 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {5 - attempts} tentative{5 - attempts > 1 ? 's' : ''} restante{5 - attempts > 1 ? 's' : ''}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Locked state */}
        {isLocked && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-destructive/10 border border-destructive/20 rounded-2xl p-5 w-full max-w-xs text-center"
          >
            <Lock className="w-8 h-8 text-destructive mx-auto mb-2" />
            <p className="text-sm text-destructive font-semibold">5 tentatives échouées</p>
            <p className="text-xs text-muted-foreground mt-1">Déconnectez-vous puis reconnectez-vous pour réessayer.</p>
          </motion.div>
        )}

        {/* Attempts dots */}
        {!isLocked && attempts > 0 && (
          <div className="flex items-center gap-1.5 mt-2 mb-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'w-2 h-2 rounded-full transition-colors duration-200',
                  i < attempts ? 'bg-destructive' : 'bg-border/40',
                )}
              />
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}
