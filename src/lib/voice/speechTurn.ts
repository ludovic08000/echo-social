export interface RecognitionAlternative { transcript: string; }
export interface RecognitionResult extends ArrayLike<RecognitionAlternative> { isFinal: boolean; }
export interface RecognitionEvent { results: ArrayLike<RecognitionResult>; }
export interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  abort: () => void;
  stop: () => void;
  start: () => void;
}

interface VoiceTurnOptions {
  language: string;
  onTranscript: (text: string) => void;
  onComplete: (text: string) => void;
  onError: (code: string) => void;
}

/** One gesture, one bounded turn. Interim hypotheses are never sent automatically. */
export function createSpeechTurn(recognition: BrowserRecognition, options: VoiceTurnOptions) {
  let active = true;
  let started = false;
  let finishing = false;
  let finalText = '';
  let hasInterim = false;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    if (!active) return;
    active = false;
    clearTimeout(silenceTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(finishTimer);
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition.abort(); } catch { /* Already stopped by the browser. */ }
  };
  const fail = (code: string) => {
    if (!active) return;
    release();
    options.onError(code);
  };
  const complete = () => {
    if (!active) return;
    if (!finalText || hasInterim) { fail(hasInterim ? 'incomplete' : 'no-speech'); return; }
    release();
    options.onComplete(finalText);
  };
  const finish = () => {
    if (!active || finishing) return;
    finishing = true;
    clearTimeout(silenceTimer);
    // stop() lets the engine finalize its current hypothesis before onend.
    finishTimer = setTimeout(() => fail('incomplete'), 2_000);
    try { recognition.stop(); } catch { fail('incomplete'); }
  };

  return {
    abort: release,
    finish,
    start: () => {
      if (!active || started) return;
      started = true;
      recognition.lang = options.language || 'fr-FR';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = event => {
        if (!active) return;
        clearTimeout(silenceTimer);
        const results = Array.from(event.results);
        finalText = results.filter(result => result.isFinal).map(result => result[0]?.transcript || '').join(' ').trim();
        const interim = results.filter(result => !result.isFinal).map(result => result[0]?.transcript || '').join(' ').trim();
        hasInterim = Boolean(interim);
        const draft = [finalText, interim].filter(Boolean).join(' ');
        options.onTranscript(draft.slice(0, 2_000));
        if (draft.length > 2_000) { fail('too-long'); return; }
        if (!finishing && finalText && !hasInterim) silenceTimer = setTimeout(complete, 1_500);
      };
      recognition.onerror = event => fail(event.error || 'recognition-failed');
      recognition.onend = complete;
      deadlineTimer = setTimeout(finish, 45_000);
      try { recognition.start(); } catch { fail('start-failed'); }
    },
  };
}
