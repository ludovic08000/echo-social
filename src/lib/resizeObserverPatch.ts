/**
 * Correctif ResizeObserver — invariant : aucun rappel d'observation ne doit
 * s'exécuter de façon synchrone pendant le calcul de layout.
 *
 * Les composants tiers (Radix popper/slider/scroll-area, carrousels) mesurent
 * le DOM dans leur callback ResizeObserver ; quand ce callback modifie lui-
 * même le layout, Chromium émet « ResizeObserver loop completed with
 * undelivered notifications » et peut vider l'écran dans l'aperçu.
 * Différer le callback d'une frame (requestAnimationFrame) casse ce cycle
 * sans changer le comportement visible : la mesure arrive simplement à la
 * frame suivante.
 */
export function installResizeObserverPatch(): void {
  if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return;
  // Ne pas patcher deux fois (HMR).
  if ((window.ResizeObserver as unknown as { __forsurePatched?: boolean }).__forsurePatched) return;

  const NativeResizeObserver = window.ResizeObserver;

  class PatchedResizeObserver extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      let frameId = 0;
      let queuedEntries: ResizeObserverEntry[] = [];
      const wrapped: ResizeObserverCallback = (entries, observer) => {
        queuedEntries = entries;
        if (frameId) return;
        frameId = window.requestAnimationFrame(() => {
          frameId = 0;
          const pending = queuedEntries;
          queuedEntries = [];
          callback(pending, observer);
        });
      };
      super(wrapped);
      const originalDisconnect = this.disconnect.bind(this);
      this.disconnect = () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
          frameId = 0;
        }
        queuedEntries = [];
        originalDisconnect();
      };
    }
  }

  (PatchedResizeObserver as unknown as { __forsurePatched?: boolean }).__forsurePatched = true;
  window.ResizeObserver = PatchedResizeObserver as typeof ResizeObserver;
}
