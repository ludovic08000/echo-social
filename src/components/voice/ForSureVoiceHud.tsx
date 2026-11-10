import { useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Keyboard, Loader2, Mic2, ShieldCheck, Volume2, X, Zap, MessageSquare, Lock } from 'lucide-react';
import { createSpeechTurn, type BrowserRecognition } from '@/lib/voice/speechTurn';
import { setZeusMicrophoneActive } from '@/lib/zeusVoice';

export type VoiceHudStatus = 'ready' | 'listening' | 'processing' | 'error';

interface ForSureVoiceHudProps {
  assistantName: string;
  errorMessage?: string | null;
  onClose: () => void;
  onSpeakIntro: () => void;
  onPrepareListening?: () => void;
  onPauseListening?: () => void;
  onReadActivity?: () => Promise<void>;
  speaking?: boolean;
  language?: string;
  onSubmitCommand: (command: string, source: 'voice' | 'text') => void | Promise<void>;
  processing?: boolean;
  voiceAllowed?: boolean;
  onUpgrade?: () => void;
  onShowChat?: () => void;
  reply?: string;
  confirmation?: {preview:string;choices:{user_id:string;name:string}[];selected?:string};
  onChooseRecipient?: (id:string)=>void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserRecognition;

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
  if (code === 'network') return 'La connexion au service de dictée a été interrompue. Votre demande reste affichée ; réessayez ou envoyez-la par écrit.';
  if (code === 'incomplete') return 'La fin de votre phrase n’a pas été confirmée. La demande reste affichée : corrigez-la ou réessayez.';
  if (code === 'too-long') return 'La demande dépasse 2 000 caractères. Raccourcissez-la avant de l’envoyer.';
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
  onPrepareListening,
  onPauseListening,
  onReadActivity,
  speaking = false,
  language = 'fr-FR',
  onSubmitCommand,
  processing = false,
  voiceAllowed = false,
  onUpgrade,
  onShowChat,
  reply,
  confirmation,
  onChooseRecipient,
}: ForSureVoiceHudProps) {
  const titleId = useId();
  const descriptionId = useId();
  const reduceMotion = useReducedMotion();
  const recognitionRef = useRef<ReturnType<typeof createSpeechTurn> | null>(null);
  const submittingRef = useRef(false);
  const conversationActiveRef = useRef(false);
  const listenAgainRef = useRef<() => void>(() => {});
  const dialogRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<VoiceHudStatus>('ready');
  const [command, setCommand] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const speechSupported = getSpeechRecognitionConstructor() !== null;
  const activeError = errorMessage || localError;

  const stopRecognition = () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.abort();
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      conversationActiveRef.current = false;
      onPauseListening?.();
      window.removeEventListener('keydown', handleKeyDown);
      stopRecognition();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose, onPauseListening]);

  useEffect(() => {
    if (!voiceAllowed) {
      conversationActiveRef.current = false;
      stopRecognition();
      setStatus(current => current === 'listening' ? 'ready' : current);
    }
  }, [voiceAllowed]);

  useEffect(()=>{
    const pause=()=>{
      if(document.visibilityState==='visible')return;
      conversationActiveRef.current=false;stopRecognition();onPauseListening?.();setStatus('ready');
    };
    document.addEventListener('visibilitychange',pause);
    return()=>document.removeEventListener('visibilitychange',pause);
  },[onPauseListening]);

  useEffect(() => {
    if (processing) setStatus('processing');
    else if (status === 'processing' && !submittingRef.current) setStatus('ready');
  }, [processing, status]);
  useEffect(()=>{
    if(!processing&&!speaking&&status==='ready'&&conversationActiveRef.current&&!submittingRef.current&&!recognitionRef.current)listenAgainRef.current();
  },[processing,speaking,status]);

  const submit = async (rawCommand = command, source: 'voice' | 'text' = 'text') => {
    const text = rawCommand.trim();
    if (!text || processing || submittingRef.current || (source === 'voice' && !voiceAllowed)) return;
    submittingRef.current = true;
    stopRecognition();
    setStatus('processing');
    setLocalError(null);
    try {
      await onSubmitCommand(text, source);
    } catch {
      conversationActiveRef.current = false;
      setLocalError('La demande n’a pas pu être transmise. Réessayez.');
    } finally {
      submittingRef.current = false;
      setStatus('ready');
    }
  };

  const startListening = () => {
    if (processing || submittingRef.current || !voiceAllowed) return;
    if (recognitionRef.current) { recognitionRef.current.finish(); return; }
    conversationActiveRef.current = true;
    setLocalError(null);

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      conversationActiveRef.current = false;
      onSpeakIntro();
      return;
    }

    // Stop speech before opening the microphone: Zeus must not transcribe itself.
    onPrepareListening?.();
    stopRecognition();
    const recognition = new Recognition();
    const turn = createSpeechTurn(recognition, {
      language,
      onCaptureChange:setZeusMicrophoneActive,
      onTranscript: setCommand,
      onComplete: transcript => {
        if (recognitionRef.current !== turn) return;
        recognitionRef.current = null;
        void submit(transcript, 'voice');
      },
      onError: code => {
        if (recognitionRef.current !== turn) return;
        recognitionRef.current = null;
        conversationActiveRef.current = false;
        setStatus('error');
        setLocalError(readableRecognitionError(code));
      },
    });
    recognitionRef.current = turn;
    setCommand('');
    setStatus('listening');
    turn.start();
  };
  listenAgainRef.current=startListening;

  const pauseConversation=()=>{
    conversationActiveRef.current=false;stopRecognition();onPauseListening?.();setStatus('ready');
  };

  const stateCopy: Record<VoiceHudStatus, { eyebrow: string; title: string; detail: string }> = {
    ready: {
      eyebrow: voiceAllowed ? 'Commandes vocales' : 'Votre assistant',
      title: `Bonjour, je suis ${assistantName}`,
      detail: !voiceAllowed
        ? 'Écrivez votre demande. Les commandes vocales sont incluses avec l’abonnement Créateur.'
        : speechSupported
        ? `Touchez le micro : votre demande sera envoyée directement à ${assistantName}, puis sa réponse sera lue.`
        : `La dictée n’est pas disponible ici. Écrivez votre demande : ${assistantName} la traitera de la même manière.`,
    },
    listening: {
      eyebrow: 'Microphone actif',
      title: 'Je vous écoute',
      detail: `Dites votre demande naturellement. ${assistantName} vous répondra à voix haute.`,
    },
    processing: {
      eyebrow: 'Demande transmise',
      title: 'Je prépare la réponse',
      detail: 'Aucune publication, aucun message et aucun réglage ne seront exécutés sans votre confirmation.',
    },
    error: {
      eyebrow: 'Demande interrompue',
      title: 'Réessayez votre demande',
      detail: activeError || 'Écrivez votre demande pour continuer avec Zeus.',
    },
  };
  const copy = stateCopy[activeError ? 'error' : status];

  return (
    <section
      ref={dialogRef}
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="fixed inset-0 z-[100] isolate flex min-h-0 flex-col overflow-y-auto bg-[#030914] text-white"
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
          <p className="font-mono text-[9px] uppercase tracking-[0.34em] text-blue-200/60">ForSure Assistant</p>
          <p className="mt-1 text-sm font-semibold tracking-[0.12em] text-blue-50">{assistantName.toUpperCase()}</p>
        </div>
        <div className="flex gap-2">
        {onShowChat && <button type="button" onClick={onShowChat} aria-label="Ouvrir le chat et les confirmations" className="grid h-9 w-9 place-items-center rounded-full border border-blue-300/20 text-blue-100"><MessageSquare className="h-4 w-4" /></button>}
        <button
          aria-label="Fermer l’interface vocale"
          autoFocus
          className="grid h-9 w-9 place-items-center rounded-full border border-blue-300/20 bg-blue-400/5 text-blue-100/70 transition hover:border-blue-200/50 hover:bg-blue-300/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
        </div>
      </header>

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 pb-3">
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
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white" id={titleId}>{speaking ? `${assistantName} vous répond` : copy.title}</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-blue-100/60" id={descriptionId}>{copy.detail}</p>
        </div>

        {reply && <div role="status" className="mt-4 max-h-32 w-full max-w-lg overflow-y-auto rounded-xl border border-blue-200/20 bg-white/5 px-4 py-3 text-sm leading-relaxed text-blue-50 whitespace-pre-wrap">{reply}</div>}

        {confirmation&&<div className="mt-3 w-full max-w-lg rounded-xl border border-blue-200/30 p-3 text-sm">
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap">{confirmation.preview}</p>
          {confirmation.choices.map(person=><button key={person.user_id} type="button" aria-pressed={confirmation.selected===person.user_id} disabled={processing} onClick={()=>onChooseRecipient?.(person.user_id)} className="m-1 rounded-full border border-blue-200/30 px-3 py-2">{person.name}{confirmation.selected===person.user_id?' ✓':''}</button>)}
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={processing||(confirmation.choices.length>0&&!confirmation.selected)} onClick={()=>{onPrepareListening?.();void submit('je confirme',voiceAllowed?'voice':'text');}} className="rounded-full bg-blue-600 px-4 py-2">Confirmer la proposition</button>
            <button type="button" disabled={processing} onClick={()=>void submit('annule','text')} className="rounded-full border border-blue-200/30 px-4 py-2">Annuler</button>
          </div>
        </div>}

        <div className="mt-4 flex w-full max-w-sm flex-col gap-2">
          {onReadActivity && <button type="button" disabled={processing} onClick={()=>{pauseConversation();void onReadActivity();}} className="min-h-10 rounded-full border border-blue-300/25 px-4 text-xs">Lire mon bilan : messages et notifications</button>}
          {(status==='listening'||processing||speaking) && <button type="button" onClick={pauseConversation} className="min-h-10 rounded-full border border-blue-300/25 px-4 text-xs">Mettre la conversation vocale en pause</button>}
          <button
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-blue-300/35 bg-blue-400/15 px-5 text-xs font-semibold text-blue-50 transition hover:border-blue-200/70 hover:bg-blue-300/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-55"
            disabled={processing}
            onClick={voiceAllowed ? startListening : onUpgrade}
            type="button"
          >
            {!voiceAllowed ? <Lock className="h-4 w-4" /> : status === 'listening' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic2 className="h-4 w-4" />}
            {!voiceAllowed ? 'Découvrir les commandes vocales Créateur' : status === 'listening' ? 'Terminer et envoyer' : speechSupported ? 'Parler à ' + assistantName : `Tester la voix de ${assistantName}`}
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
            onClick={() => void submit()}
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
