/**
 * MessagingPinGate — Premium PIN gate for encrypted messaging.
 * Supports compact mode for chat widget (small container).
 */

import { useState, useRef, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { Lock, Shield, ShieldCheck, Eye, EyeOff, KeyRound, ArrowLeft, Fingerprint, Mail, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatPin } from '@/hooks/useChatPin';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

const CompactCtx = createContext(false);

interface MessagingPinGateProps {
  children: ReactNode;
  /** Compact mode for small containers like chat widget */
  compact?: boolean;
}

export function MessagingPinGate({ children, compact = false }: MessagingPinGateProps) {
  const pin = useChatPin();

  if (!pin.loaded) {
    return (
      <div className={cn('flex items-center justify-center', compact ? 'h-full' : 'h-full min-h-[50vh]')}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-2"
        >
          <div className={cn('relative', compact ? 'w-8 h-8' : 'w-12 h-12')}>
            <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Lock className={cn(compact ? 'w-3 h-3' : 'w-5 h-5', 'text-primary/60')} />
            </div>
          </div>
          {!compact && <p className="text-xs text-muted-foreground animate-pulse">Chargement sécurisé…</p>}
        </motion.div>
      </div>
    );
  }

  if (pin.unlocked) return <>{children}</>;

  return (
    <CompactCtx.Provider value={compact}>
      {!pin.hasPin
        ? <PinSetupScreen onSetup={pin.setupPin} processing={pin.processing} error={pin.error} />
        : <PinEntryScreen
            onVerify={pin.verifyPin}
            processing={pin.processing}
            error={pin.error}
            onRequestReset={pin.requestReset}
            onConfirmReset={pin.confirmReset}
          />
      }
    </CompactCtx.Provider>
  );
}

// ─── PIN Input ───

function PinInput({
  value, showPin, hasError, disabled, onDigit, onBackspace, autoFocus = true,
}: {
  value: string; showPin: boolean; hasError?: boolean; disabled?: boolean;
  onDigit: (d: string, i: number) => void; onBackspace: (i: number) => void; autoFocus?: boolean;
}) {
  const compact = useContext(CompactCtx);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) setTimeout(() => refs.current[0]?.focus(), 200);
  }, [autoFocus]);

  return (
    <div className={cn('flex items-center justify-center', compact ? 'gap-1.5' : 'gap-2 sm:gap-3')}>
      {Array.from({ length: 6 }).map((_, i) => {
        const filled = !!value[i];
        return (
          <motion.div
            key={i}
            initial={false}
            animate={
              hasError
                ? { x: [0, -4, 4, -2, 2, 0], transition: { duration: 0.3 } }
                : filled ? { scale: [1, 1.06, 1], transition: { duration: 0.1 } } : {}
            }
          >
            <input
              ref={el => { refs.current[i] = el; }}
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
                  if (i < 5) setTimeout(() => refs.current[i + 1]?.focus(), 10);
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Backspace') {
                  e.preventDefault();
                  onBackspace(i);
                  if (!value[i] && i > 0) setTimeout(() => refs.current[i - 1]?.focus(), 10);
                } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
                else if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
              }}
              onFocus={e => e.target.select()}
              className={cn(
                compact
                  ? 'w-9 h-10 text-base rounded-lg'
                  : 'w-10 h-12 sm:w-12 sm:h-14 text-lg sm:text-xl rounded-xl sm:rounded-2xl',
                'text-center font-bold border-2 outline-none transition-all duration-150',
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

// ─── Helpers ───

function VisibilityToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1 text-[10px] sm:text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5"
    >
      {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      {show ? 'Masquer' : 'Afficher'}
    </button>
  );
}

function usePinHandlers(setter: React.Dispatch<React.SetStateAction<string>>) {
  const handleDigit = useCallback((digit: string, index: number) => {
    setter(prev => {
      const arr = prev.split('');
      arr[index] = digit;
      return arr.join('').substring(0, 6);
    });
  }, [setter]);

  const handleBackspace = useCallback((index: number) => {
    setter(prev => {
      const arr = prev.split('');
      if (arr[index]) arr[index] = '';
      else if (index > 0) arr[index - 1] = '';
      return arr.join('');
    });
  }, [setter]);

  return { handleDigit, handleBackspace };
}

// ─── PIN Setup Screen ───

function PinSetupScreen({ onSetup, processing, error }: {
  onSetup: (pin: string) => Promise<boolean>; processing: boolean; error: string | null;
}) {
  const compact = useContext(CompactCtx);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'create' | 'confirm'>('create');
  const [showPin, setShowPin] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const currentPin = step === 'create' ? pin : confirmPin;
  const currentSetter = step === 'create' ? setPin : setConfirmPin;
  const { handleDigit, handleBackspace } = usePinHandlers(currentSetter);
  const displayError = localError || error;

  const wrappedDigit = useCallback((d: string, i: number) => {
    handleDigit(d, i);
    setLocalError(null);
  }, [handleDigit]);

  const handleNext = async () => {
    setLocalError(null);
    if (step === 'create') {
      if (pin.length !== 6) { setLocalError('Entrez 6 chiffres'); return; }
      setStep('confirm');
      setConfirmPin('');
    } else {
      if (confirmPin !== pin) { setLocalError('Les PIN ne correspondent pas'); setConfirmPin(''); return; }
      await onSetup(pin);
    }
  };

  return (
    <div className={cn(
      'flex items-center justify-center h-full overflow-y-auto',
      compact ? 'px-3 py-4' : 'px-4 py-6 sm:py-8 min-h-[50vh]',
    )}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className={cn('w-full flex flex-col items-center', compact ? 'max-w-full' : 'max-w-sm')}
      >
        {/* Icon */}
        {!compact && (
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
        )}

        {compact && (
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
            <KeyRound className="w-5 h-5 text-primary" />
          </div>
        )}

        {/* Title */}
        <div className={cn('text-center', compact ? 'mb-3' : 'mb-5 sm:mb-6 px-2')}>
          <h2 className={cn(
            'font-bold text-foreground tracking-tight',
            compact ? 'text-sm mb-1' : 'text-lg sm:text-xl mb-1.5',
          )}>
            {step === 'create' ? 'Créez votre code PIN' : 'Confirmez votre code'}
          </h2>
          <p className={cn(
            'text-muted-foreground leading-relaxed',
            compact ? 'text-[10px]' : 'text-xs sm:text-sm',
          )}>
            {step === 'create'
              ? 'Ce code à 6 chiffres protège vos conversations chiffrées.'
              : 'Ressaisissez votre code PIN pour confirmer.'}
          </p>
        </div>

        {/* Step indicator */}
        <div className={cn('flex items-center gap-1.5', compact ? 'mb-3' : 'mb-5 sm:mb-6')}>
          <div className={cn('h-1 rounded-full bg-primary', compact ? 'w-5' : 'w-6 sm:w-8')} />
          <div className={cn(
            'h-1 rounded-full transition-colors duration-300',
            compact ? 'w-5' : 'w-6 sm:w-8',
            step === 'confirm' ? 'bg-primary' : 'bg-border/30',
          )} />
        </div>

        {/* PIN Input */}
        <div className={compact ? 'mb-2' : 'mb-4'}>
          <PinInput
            value={currentPin}
            showPin={showPin}
            hasError={!!displayError}
            onDigit={wrappedDigit}
            onBackspace={handleBackspace}
          />
        </div>

        <VisibilityToggle show={showPin} onToggle={() => setShowPin(!showPin)} />

        {/* Error */}
        <AnimatePresence>
          {displayError && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className={cn(
                'text-destructive font-medium text-center',
                compact ? 'text-[10px] mt-1.5' : 'text-xs sm:text-sm mt-3',
              )}
            >
              {displayError}
            </motion.p>
          )}
        </AnimatePresence>

        {/* Actions */}
        <div className={cn('w-full space-y-1.5', compact ? 'mt-3' : 'mt-5 sm:mt-6')}>
          <Button
            onClick={handleNext}
            disabled={currentPin.length !== 6 || processing}
            className={cn(
              'w-full font-semibold',
              compact ? 'h-9 rounded-lg text-xs' : 'h-11 sm:h-12 rounded-xl sm:rounded-2xl text-sm',
            )}
            size={compact ? 'sm' : 'lg'}
          >
            {processing ? (
              <span className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                {!compact && 'Chiffrement…'}
              </span>
            ) : step === 'create' ? 'Continuer' : (
              <span className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5" />
                {compact ? 'Activer' : 'Activer la protection'}
              </span>
            )}
          </Button>

          {step === 'confirm' && (
            <button
              onClick={() => { setStep('create'); setPin(''); setConfirmPin(''); setLocalError(null); }}
              className="w-full flex items-center justify-center gap-1 text-[10px] sm:text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <ArrowLeft className="w-3 h-3" />
              Recommencer
            </button>
          )}
        </div>

        {/* Security notice — hide in compact */}
        {!compact && (
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
        )}
      </motion.div>
    </div>
  );
}

// ─── PIN Entry Screen ───

function PinEntryScreen({ onVerify, processing, error, onRequestReset, onConfirmReset }: {
  onVerify: (pin: string) => Promise<boolean>; processing: boolean; error: string | null;
  onRequestReset: () => Promise<boolean>;
  onConfirmReset: (code: string) => Promise<boolean>;
}) {
  const compact = useContext(CompactCtx);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const submittingRef = useRef(false);
  const { handleDigit, handleBackspace } = usePinHandlers(setPin);

  // Reset flow states
  const [resetStep, setResetStep] = useState<'none' | 'sending' | 'code' | 'success'>('none');
  const [resetCode, setResetCode] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const { handleDigit: handleCodeDigit, handleBackspace: handleCodeBackspace } = usePinHandlers(setResetCode);

  useEffect(() => {
    if (pin.length === 6 && !processing && !submittingRef.current && attempts < 5 && resetStep === 'none') {
      submittingRef.current = true;
      onVerify(pin).then(ok => {
        submittingRef.current = false;
        if (!ok) { setAttempts(a => a + 1); setPin(''); }
      });
    }
  }, [pin, processing, attempts, onVerify, resetStep]);

  const isLocked = attempts >= 5;

  const handleRequestReset = async () => {
    setResetStep('sending');
    setResetError(null);
    const ok = await onRequestReset();
    if (ok) {
      setResetStep('code');
      setResetCode('');
    } else {
      setResetError('Erreur envoi email');
      setResetStep('none');
    }
  };

  const handleConfirmReset = async () => {
    if (resetCode.length !== 6) return;
    setResetError(null);
    const ok = await onConfirmReset(resetCode);
    if (ok) {
      setResetStep('success');
    } else {
      setResetCode('');
    }
  };

  // Auto-submit reset code
  useEffect(() => {
    if (resetCode.length === 6 && resetStep === 'code' && !processing) {
      handleConfirmReset();
    }
  }, [resetCode, resetStep, processing]);

  // ── Reset code entry screen ──
  if (resetStep === 'code') {
    return (
      <div className={cn(
        'flex items-center justify-center h-full overflow-y-auto',
        compact ? 'px-3 py-4' : 'px-4 py-6 sm:py-8 min-h-[50vh]',
      )}>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn('w-full flex flex-col items-center', compact ? 'max-w-full' : 'max-w-sm')}
        >
          <div className={cn(
            'rounded-2xl flex items-center justify-center border bg-gradient-to-br from-primary/15 to-primary/5 border-primary/10',
            compact ? 'w-10 h-10 rounded-xl mb-3' : 'w-16 h-16 sm:w-20 sm:h-20 sm:rounded-3xl mb-5 sm:mb-6',
          )}>
            <Mail className={cn(compact ? 'w-5 h-5' : 'w-8 h-8 sm:w-10 sm:h-10', 'text-primary')} />
          </div>

          <div className={cn('text-center', compact ? 'mb-3' : 'mb-5 sm:mb-6 px-2')}>
            <h2 className={cn('font-bold text-foreground tracking-tight', compact ? 'text-sm mb-0.5' : 'text-lg sm:text-xl mb-1.5')}>
              Vérification par email
            </h2>
            <p className={cn('text-muted-foreground', compact ? 'text-[10px]' : 'text-xs sm:text-sm')}>
              Entrez le code à 6 chiffres envoyé à votre adresse email.
            </p>
          </div>

          <div className={compact ? 'mb-2' : 'mb-4'}>
            <PinInput
              value={resetCode}
              showPin={true}
              hasError={!!resetError || !!error}
              disabled={processing}
              onDigit={handleCodeDigit}
              onBackspace={handleCodeBackspace}
            />
          </div>

          <AnimatePresence>
            {(resetError || error) && !processing && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className={cn('text-destructive font-medium text-center', compact ? 'text-[10px] mt-1.5' : 'text-xs sm:text-sm mt-3')}
              >
                {resetError || error}
              </motion.p>
            )}
          </AnimatePresence>

          {processing && (
            <div className={cn('flex items-center gap-1.5 text-muted-foreground', compact ? 'text-[10px] mt-2' : 'text-xs sm:text-sm mt-3')}>
              <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Vérification…
            </div>
          )}

          <button
            onClick={() => { setResetStep('none'); setResetCode(''); setResetError(null); }}
            className="mt-4 flex items-center gap-1 text-[10px] sm:text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3 h-3" /> Retour
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={cn(
      'flex items-center justify-center h-full overflow-y-auto',
      compact ? 'px-3 py-4' : 'px-4 py-6 sm:py-8 min-h-[50vh]',
    )}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className={cn('w-full flex flex-col items-center', compact ? 'max-w-full' : 'max-w-sm')}
      >
        {/* Icon */}
        {!compact ? (
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
              <ShieldCheck className={cn('w-8 h-8 sm:w-10 sm:h-10', isLocked ? 'text-destructive' : 'text-primary')} />
            </div>
            {processing && (
              <div className="absolute inset-0 rounded-2xl sm:rounded-3xl border-2 border-primary border-t-transparent animate-spin" />
            )}
          </motion.div>
        ) : (
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center mb-3',
            isLocked ? 'bg-destructive/10' : 'bg-primary/10',
          )}>
            <ShieldCheck className={cn('w-5 h-5', isLocked ? 'text-destructive' : 'text-primary')} />
          </div>
        )}

        {/* Title */}
        <div className={cn('text-center', compact ? 'mb-3' : 'mb-5 sm:mb-6 px-2')}>
          <h2 className={cn(
            'font-bold text-foreground tracking-tight',
            compact ? 'text-sm mb-0.5' : 'text-lg sm:text-xl mb-1.5',
          )}>
            {isLocked ? 'Accès bloqué' : (compact ? 'Code PIN' : 'Déverrouiller la messagerie')}
          </h2>
          <p className={cn('text-muted-foreground', compact ? 'text-[10px]' : 'text-xs sm:text-sm')}>
            {isLocked
              ? (compact ? 'Réinitialisez par email.' : 'Trop de tentatives. Réinitialisez votre PIN par email.')
              : (compact ? 'Entrez votre code à 6 chiffres.' : 'Saisissez votre code à 6 chiffres pour accéder à vos messages.')}
          </p>
        </div>

        {/* PIN */}
        {!isLocked && (
          <>
            <div className={compact ? 'mb-2' : 'mb-4'}>
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

        {/* Processing */}
        <AnimatePresence>
          {processing && !isLocked && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={cn(
                'flex items-center gap-1.5 text-muted-foreground',
                compact ? 'text-[10px] mt-2' : 'text-xs sm:text-sm mt-3',
              )}
            >
              <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Déchiffrement…
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error */}
        <AnimatePresence>
          {error && !processing && !isLocked && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={cn('text-center', compact ? 'mt-1.5' : 'mt-3')}
            >
              <p className={cn('text-destructive font-medium', compact ? 'text-[10px]' : 'text-xs sm:text-sm')}>{error}</p>
              {attempts > 0 && (
                <div className="flex items-center justify-center gap-1 mt-1.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className={cn('w-1.5 h-1.5 rounded-full', i < attempts ? 'bg-destructive' : 'bg-border/40')} />
                  ))}
                  <span className="text-[9px] text-muted-foreground ml-1">{5 - attempts} restante{5 - attempts > 1 ? 's' : ''}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Forgot PIN button — always visible so the user can ALWAYS trigger
            an email reset, even on the very first wrong attempt. */}
        {!isLocked && (
          <button
            onClick={handleRequestReset}
            disabled={processing || resetStep === 'sending'}
            className={cn(
              'flex items-center gap-1 text-primary hover:text-primary/80 transition-colors mx-auto',
              compact ? 'text-[10px] mt-2' : 'text-xs mt-4',
            )}
          >
            <RotateCcw className="w-3 h-3" />
            {resetStep === 'sending' ? 'Envoi de l\'email…' : 'PIN oublié ? Recevoir un code par email'}
          </button>
        )}

        {/* Locked — show reset button */}
        {isLocked && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className={cn(
              'w-full text-center',
              compact ? 'mt-2' : 'mt-3',
            )}
          >
            <div className={cn(
              'bg-destructive/10 border border-destructive/15 w-full mb-3',
              compact ? 'rounded-lg p-2.5' : 'rounded-xl sm:rounded-2xl p-4',
            )}>
              <Lock className={cn('mx-auto mb-1', compact ? 'w-4 h-4 text-destructive' : 'w-6 h-6 text-destructive')} />
              <p className={cn('text-destructive font-semibold', compact ? 'text-[10px]' : 'text-sm')}>5 tentatives échouées</p>
            </div>

            <Button
              onClick={handleRequestReset}
              disabled={processing || resetStep === 'sending'}
              variant="outline"
              className={cn(
                'w-full font-semibold gap-2',
                compact ? 'h-9 rounded-lg text-xs' : 'h-11 sm:h-12 rounded-xl sm:rounded-2xl text-sm',
              )}
              size={compact ? 'sm' : 'lg'}
            >
              {resetStep === 'sending' ? (
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
              Réinitialiser par email
            </Button>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
