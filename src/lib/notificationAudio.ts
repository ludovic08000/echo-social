// Un seul contexte pour les alertes : déverrouillé pendant un geste utilisateur,
// pas seulement à l'arrivée asynchrone d'un message ou d'un appel (iOS).
let context: AudioContext | null = null;
let listeners = 0;

export function getNotificationAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!context || context.state === 'closed') {
    const Constructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    context = new Constructor();
  }
  return context;
}

export async function resumeNotificationAudio(): Promise<AudioContext | null> {
  try {
    const ctx = getNotificationAudioContext();
    if (!ctx) return null;
    if (ctx.state !== 'running') await ctx.resume();
    return ctx.state === 'running' ? ctx : null;
  } catch {
    return null;
  }
}

function unlock(event: Event) {
  if (event.isTrusted) void resumeNotificationAudio();
}

export function installNotificationAudioUnlock(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (listeners++ === 0) {
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('touchend', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (--listeners === 0) {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('touchend', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    }
  };
}
