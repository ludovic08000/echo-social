import { useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Keyboard, Loader2, Mic2, ShieldCheck, Volume2, X, Zap } from 'lucide-react';

export type VoiceHudStatus = 'ready' | 'listening' | 'processing' | 'error';

interface ForSureVoiceHudProps {
  assistantName: string;
  errorMessage?: string | null;
  onClose: () => void;
  onSpeakIntro: () => void;
  onSubmitCommand: (command: string) => void | Promise<void>;
  processing?: boolean;
}

interface SpeechRecognitionResultLike { transcript: string; }
interface SpeechRecognitionEventLike { results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>>; }

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  abort: () => void;
  start: () => void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const browserWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition || null;
}

function readableRecognitionError(code?: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'L’accès au microphone a été refusé. Autorisez-le dans le navigateur puis réessayez.';
  }
  if (code === 'no-speech') return 'Je n’ai rien entendu. Réessayez ou écrivez votre demande.';
  if (code === 'audio-capture') return 'Aucun microphone n’est disponible sur cet appareil.';
  return 'La dictée vocale est indisponible. Vous pouvez écrire votre demande.';
}

function Orbit({ className, duration, reverse = false }: { className: string; duration: number; reverse?: boolean }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      aria-hidden="true"
      className={className}
      animate={reduceMotion ? undefined : { rotate: reverse ? -360 : 360 }}
      transition={reduceMotion ? undefined : { duration, ease: 'linear', repeat: Infinity }}
    />
  );
}

export function ForSureVoiceHud({
  assistantName,
  errorMessage,
  onClose,
  onSpeakIntro,
  onSubmitCommand,
  processing = false,
}: ForSureVoiceHudProps) {
  const titleId = useId();
  const descriptionId = useId();
  const reduceMotion = useReducedMotion();
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const [status, setStatus] = useState<VoiceHudStatus>('ready');
  const [command, setCommand] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const speechSupported = getSpeechRecognitionConstructor() !== null;
  const activeError = errorMessage || localError;

  const stopRecognition = () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
    try { recognition.abort(); } catch {
      // The recognition implementation may already be stopped.
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      stopRecognition();
    };
  }, [onClose]);

  useEffect(() => {
    if (processing) setStatus('processing');
    else if (status === 'processing') setStatus('ready');
  }, [processing, status]);

  const startListening = () => {
    if (processing) return;
    setLocalError(null);
    onSpeakIntro();

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setStatus('error');
      setLocalError('La dictée vocale n’est pas proposée par ce navigateur. Écrivez votre demande ci-dessous.');
      return;
    }

    stopRecognition();
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'fr-FR';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || '')
        .join(' ')
        .trim();
      if (transcript) setCommand(transcript.slice(0, 2_000));
      setStatus('ready');
    };
    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setStatus('error');
      setLocalError(readableRecognitionError(event.error));
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setStatus((current) => current === 'listening' ? 'ready' : current);
    };
    recognitionRef.current = recognition;
    setStatus('listening');
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setStatus('error');
      setLocalError('La dictée ne peut pas démarrer. Réessayez ou écrivez votre demande.');
    }
  };

  const submit = async () => {
    const text = command.trim();
    if (!text || processing) return;
    stopRecognition();
    setStatus('processing');
    setLocalError(null);
    await onSubmitCommand(text);
  };

  const stateCopy: Record<VoiceHudStatus, { eyebrow: string; title: string; detail: string }> = {
    ready: {
      eyebrow: 'Commande vocale',
      title: `Parlez à ${assistantName}`,
      detail: speechSupported
        ? 'Touchez le micro, dictez votre demande, puis vérifiez-la avant l’envoi.'
        : `La dictée n’est pas disponible ici. Écrivez votre demande : ${assistantName} la traitera de la même manière.`,
    },
    listening: {
      eyebrow: 'Microphone actif',
      title: 'Je vous écoute',
      detail: 'Dites votre demande naturellement. Vous pourrez toujours la vérifier et la modifier.',
    },
    processing: {
      eyebrow: 'Demande transmise',
      title: 'Je prépare la réponse',
      detail: 'Aucune publication, aucun message et aucun réglage ne seront exécutés sans votre confirmation.',
    },
    error: {
      eyebrow: 'Microphone indisponible',
      title: 'Utilisez la saisie',
      detail: activeError || 'Écrivez votre demande pour continuer avec Zeus.',
    },
  };
  const copy = stateCopy[status];

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="absolute inset-0 z-50 isolate flex min-h-0 flex-col overflow-hidden bg-[#030914] text-white"
      role="dialog"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-35"
        style={{
          backgroundImage: 'linear-gradient(rgba(70, 167, 255, 0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(70, 167, 255, 0.16) 1px, transparent 1px)',
          backgroundSize: '36px 36px',
          maskImage: 'radial-gradient(circle at center, black 15%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(circle at center, black 15%, transparent 78%)',
        }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(40,139,255,0.2),transparent_56%)]" />
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-300/70 to-transparent" />

      <header className="relative z-10 flex items-start justify-between px-4 pb-2 pt-4">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.34em] text-blue-200/60">ForSure Voice</p>
          <p className="mt-1 text-sm font-semibold tracking-[0.12em] text-blue-50">{assistantName.toUpperCase()}</p>
        </div>
        <button
          aria-label="Fermer l’interface vocale"
          autoFocus
          className="grid h-9 w-9 place-items-center rounded-full border border-blue-300/20 bg-blue-400/5 text-blue-100/70 transition hover:border-blue-200/50 hover:bg-blue-300/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-5 pb-3">
        <div className="relative grid h-36 w-36 max-h-[30vh] max-w-[56vw] shrink-0 place-items-center sm:h-40 sm:w-40">
          <div aria-hidden="true" className="absolute inset-[14%] rounded-full bg-blue-400/15 blur-3xl" />
          <Orbit className="absolute inset-0 rounded-full border border-dashed border-blue-300/25" duration={26} />
          <Orbit className="absolute inset-[8%] rounded-full border-2 border-blue-300/30 [clip-path:polygon(0_0,64%_0,64%_20%,100%_20%,100%_100%,35%_100%,35%_80%,0_80%)]" duration={17} reverse />
          <Orbit className="absolute inset-[18%] rounded-full border border-dotted border-cyan-200/50" duration={11} />
          <motion.div
            className="relative grid h-20 w-20 place-items-center rounded-full border border-blue-100/50 bg-[radial-gradient(circle_at_50%_38%,#d9f2ff_0%,#5ab2ff_30%,#176ee8_62%,#071d4b_100%)] shadow-[0_0_24px_rgba(72,158,255,0.65),0_0_70px_rgba(35,114,255,0.28),inset_0_0_22px_rgba(255,255,255,0.5)] sm:h-24 sm:w-24"
            animate={reduceMotion ? undefined : status === 'listening' ? { scale: [1, 1.08, 1] } : { opacity: [0.8, 1, 0.8] }}
            transition={reduceMotion ? undefined : { duration: status === 'listening' ? 1.1 : 1.8, ease: 'easeInOut', repeat: Infinity }}
          >
            {status === 'processing' ? <Loader2 className="h-8 w-8 animate-spin text-white" /> : status === 'listening' ? <Mic2 className="h-9 w-9 text-white" /> : <Zap className="h-9 w-9 fill-white/20 text-white" />}
          </motion.div>
        </div>

        <div aria-live="polite" className="mt-1 max-w-sm text-center">
          <p className="font-mono text-[9px] uppercase tracking-[0.32em] text-cyan-200/65">{copy.eyebrow}</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white" id={titleId}>{copy.title}</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-blue-100/60" id={descriptionId}>{copy.detail}</p>
        </div>

        <div className="mt-4 flex w-full max-w-sm flex-col gap-2">
          <button
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-blue-300/35 bg-blue-400/15 px-5 text-xs font-semibold text-blue-50 transition hover:border-blue-200/70 hover:bg-blue-300/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-55"
            disabled={processing || status === 'listening'}
            onClick={startListening}
            type="button"
          >
            {status === 'listening' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic2 className="h-4 w-4" />}
            {speechSupported ? 'Dicter une demande' : `Tester la voix de ${assistantName}`}
          </button>

          <label className="sr-only" htmlFor="forsure-voice-command">Votre demande à {assistantName}</label>
          <textarea
            className="min-h-20 w-full resize-none rounded-xl border border-blue-200/20 bg-black/20 px-3 py-2.5 text-sm text-white outline-none placeholder:text-blue-100/35 focus:border-blue-200/60 focus:ring-2 focus:ring-blue-300/35"
            disabled={processing}
            id="forsure-voice-command"
            maxLength={2_000}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Ex. « Prépare une publication sur ma sortie sportive »"
            value={command}
          />
          <button
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-blue-300/25 bg-white/10 px-5 text-xs font-semibold text-blue-50 transition hover:border-blue-200/60 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!command.trim() || processing}
            onClick={submit}
            type="button"
          >
            {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Keyboard className="h-4 w-4" />}
            Envoyer à {assistantName}
          </button>
        </div>
      </div>

      <footer className="relative z-10 grid grid-cols-3 gap-1 border-t border-blue-300/10 bg-[#071122]/70 px-3 py-3 text-center font-mono text-[8px] uppercase leading-tight tracking-[0.12em] text-blue-100/45 backdrop-blur">
        <div className="flex items-center justify-center gap-1.5"><ShieldCheck className="h-3 w-3 shrink-0 text-emerald-300/80" />Confirmation requise</div>
        <div className="flex items-center justify-center gap-1.5"><Mic2 className="h-3 w-3 shrink-0 text-blue-300/80" />Micro sur demande</div>
        <div className="flex items-center justify-center gap-1.5"><Volume2 className="h-3 w-3 shrink-0 text-cyan-300/80" />Pas d’audio stocké</div>
      </footer>
    </section>
  );
}
