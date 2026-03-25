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
      <div className="flex items-center justify-center h-full min-h-[50vh]">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-3"
        >
          <div className="relative w-12 h-12">
            <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Lock className="w-5 h-5 text-primary/60" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">Chargement sécurisé…</p>
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

// ─── Shared PIN Input Component ───

function PinInput({
  value,
  showPin,
  hasError,
  disabled,
  onDigit,
  onBackspace,
  autoFocus = true,
}: {
  value: string;
  showPin: boolean;
  hasError?: boolean;
  disabled?: boolean;
  onDigit: (digit: string, index: number) => void;
  onBackspace: (index: number) => void;
  autoFocus?: boolean;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) {
      setTimeout(() => inputRefs.current[0]?.focus(), 200);
    }
  }, [autoFocus]);

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      {Array.from({ length: 6 }).map((_, i) => {
        const filled = !!value[i];
        return (
          <motion.div
            key={i}
            initial={false}
            animate={
              hasError
                ? { x: [0, -5, 5, -3, 3, 0], transition: { duration: 0.35 } }
                : filled
                  ? { scale: [1, 1.08, 1], transition: { duration: 0.12 } }
                  : {}
            }
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
                  if (i < 5) setTimeout(() => inputRefs.current[i + 1]?.focus(), 10);
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Backspace') {
                  e.preventDefault();
                  onBackspace(i);
                  if (!value[i] && i > 0) setTimeout(() => inputRefs.current[i - 1]?.focus(), 10);
                } else if (e.key === 'ArrowLeft' && i > 0) {
                  inputRefs.current[i - 1]?.focus();
                } else if (e.key === 'ArrowRight' && i < 5) {
                  inputRefs.current[i + 1]?.focus();
                }
              }}
              onFocus={e => e.target.select()}
              className={cn(
                // Responsive sizing: compact on small phones, comfortable on tablets+
                'w-10 h-12 sm:w-12 sm:h-14 md:w-13 md:h-15',
                'text-center text-lg sm:text-xl font-bold',
                'rounded-xl sm:rounded-2xl border-2 outline-none',
                'transition-all duration-150',
                'bg-card text-foreground caret-primary',
                disabled && 'opacity-40 cursor-not-allowed',
                hasError
                  ? 'border-destructive bg-destructive/5'
                  : filled
                    ? 'border-primary shadow-md shadow-primary/10'
                    : 'border-border/50 focus:border-primary focus:shadow-sm focus:shadow-primary/10',
              )}
              autoComplete="one-time-code"
            />
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Visibility Toggle ───

function VisibilityToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
    >
      {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      {show ? 'Masquer' : 'Afficher'}
    </button>
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
      if (pin.length !== 6) { setLocalError('Entrez 6 chiffres'); return; }
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

  return (
    <div className="flex items-center justify-center h-full min-h-[50vh] px-4 py-6 sm:py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-sm flex flex-col items-center"
      >
        {/* Icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
          className="relative mb-5 sm:mb-6"
        >
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl sm:rounded-3xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center border border-primary/10">
            <Fingerprint className="w-8 h-8 sm:w-10 sm:h-10 text-primary" />
          </div>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.25, type: 'spring' }}
            className="absolute -bottom-1 -right-1 w-6 h-6 sm:w-7 sm:h-7 rounded-lg sm:rounded-xl bg-primary flex items-center justify-center shadow-md shadow-primary/25"
          >
            <KeyRound className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-primary-foreground" />
          </motion.div>
        </motion.div>

        {/* Title — animated on step change */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: step === 'confirm' ? 16 : -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: step === 'confirm' ? -16 : 16 }}
            transition={{ duration: 0.2 }}
            className="text-center mb-5 sm:mb-6 px-2"
          >
            <h2 className="text-lg sm:text-xl font-bold text-foreground tracking-tight mb-1.5">
              {step === 'create' ? 'Créez votre code PIN' : 'Confirmez votre code'}
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
              {step === 'create'
                ? 'Ce code à 6 chiffres protège vos conversations chiffrées.'
                : 'Ressaisissez votre code PIN pour confirmer.'}
            </p>
          </motion.div>
        </AnimatePresence>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 mb-5 sm:mb-6">
          <div className="w-6 sm:w-8 h-1 rounded-full bg-primary transition-colors" />
          <div className={cn(
            'w-6 sm:w-8 h-1 rounded-full transition-colors duration-300',
            step === 'confirm' ? 'bg-primary' : 'bg-border/30',
          )} />
        </div>

        {/* PIN Input */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="mb-4"
          >
            <PinInput
              value={currentPin}
              showPin={showPin}
              hasError={!!displayError}
              onDigit={handleDigit}
              onBackspace={handleBackspace}
            />
          </motion.div>
        </AnimatePresence>

        <VisibilityToggle show={showPin} onToggle={() => setShowPin(!showPin)} />

        {/* Error */}
        <AnimatePresence>
          {displayError && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="text-xs sm:text-sm text-destructive font-medium text-center mt-3"
            >
              {displayError}
            </motion.p>
          )}
        </AnimatePresence>

        {/* Action button */}
        <div className="w-full mt-5 sm:mt-6 space-y-2">
          <Button
            onClick={handleNext}
            disabled={currentPin.length !== 6 || processing}
            className="w-full h-11 sm:h-12 rounded-xl sm:rounded-2xl text-sm font-semibold"
            size="lg"
          >
            {processing ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                Chiffrement…
              </span>
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
              onClick={() => { setStep('create'); setPin(''); setConfirmPin(''); setLocalError(null); }}
              className="w-full flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <ArrowLeft className="w-3 h-3" />
              Recommencer
            </button>
          )}
        </div>

        {/* Security notice */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mt-5 sm:mt-6 flex items-start gap-2.5 bg-card border border-border/40 rounded-xl sm:rounded-2xl p-3 sm:p-3.5 w-full"
        >
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Lock className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] sm:text-xs font-semibold text-foreground mb-0.5">Important</p>
            <p className="text-[10px] sm:text-[11px] text-muted-foreground leading-relaxed">
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

  // Auto-submit when 6 digits entered
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
    <div className="flex items-center justify-center h-full min-h-[50vh] px-4 py-6 sm:py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-sm flex flex-col items-center"
      >
        {/* Header icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
          className="relative mb-5 sm:mb-6"
        >
          <div className={cn(
            'w-16 h-16 sm:w-20 sm:h-20 rounded-2xl sm:rounded-3xl flex items-center justify-center border',
            isLocked
              ? 'bg-gradient-to-br from-destructive/15 to-destructive/5 border-destructive/10'
              : 'bg-gradient-to-br from-primary/15 to-primary/5 border-primary/10',
          )}>
            <ShieldCheck className={cn(
              'w-8 h-8 sm:w-10 sm:h-10',
              isLocked ? 'text-destructive' : 'text-primary',
            )} />
          </div>
          {processing && (
            <div className="absolute inset-0 rounded-2xl sm:rounded-3xl border-2 border-primary border-t-transparent animate-spin" />
          )}
        </motion.div>

        {/* Title */}
        <div className="text-center mb-5 sm:mb-6 px-2">
          <h2 className="text-lg sm:text-xl font-bold text-foreground tracking-tight mb-1.5">
            {isLocked ? 'Accès bloqué' : 'Déverrouiller la messagerie'}
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground">
            {isLocked
              ? 'Trop de tentatives. Reconnectez-vous pour réessayer.'
              : 'Saisissez votre code à 6 chiffres pour accéder à vos messages.'}
          </p>
        </div>

        {/* PIN Input */}
        {!isLocked && (
          <>
            <div className="mb-4">
              <PinInput
                value={pin}
                showPin={showPin}
                hasError={!!error && !processing}
                disabled={processing}
                onDigit={handleDigit}
                onBackspace={handleBackspace}
              />
            </div>
            <VisibilityToggle show={showPin} onToggle={() => setShowPin(!showPin)} />
          </>
        )}

        {/* Processing state */}
        <AnimatePresence>
          {processing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground mt-3"
            >
              <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Déchiffrement…
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error + attempts remaining */}
        <AnimatePresence>
          {error && !processing && !isLocked && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="text-center mt-3"
            >
              <p className="text-xs sm:text-sm text-destructive font-medium">{error}</p>
              {attempts > 0 && (
                <div className="flex items-center justify-center gap-1 mt-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className={cn(
                        'w-1.5 h-1.5 rounded-full transition-colors',
                        i < attempts ? 'bg-destructive' : 'bg-border/40',
                      )}
                    />
                  ))}
                  <span className="text-[10px] text-muted-foreground ml-1.5">
                    {5 - attempts} restante{5 - attempts > 1 ? 's' : ''}
                  </span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Locked state */}
        {isLocked && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-destructive/10 border border-destructive/15 rounded-xl sm:rounded-2xl p-4 w-full text-center mt-2"
          >
            <Lock className="w-6 h-6 text-destructive mx-auto mb-1.5" />
            <p className="text-sm text-destructive font-semibold">5 tentatives échouées</p>
            <p className="text-xs text-muted-foreground mt-1">Déconnectez-vous puis reconnectez-vous.</p>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
