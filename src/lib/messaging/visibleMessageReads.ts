type VisibleReadOptions = {
  container: HTMLElement;
  messageIds: ReadonlySet<string>;
  canRead: (messageId: string) => boolean;
  acknowledge: (messageIds: string[]) => Promise<void>;
};

/** Un message déchiffré hors écran n'est pas lu : observer son affichage réel. */
export function observeVisibleMessageReads(options: VisibleReadOptions): () => void {
  const { container, messageIds, canRead, acknowledge } = options;
  const acknowledged = new Set<string>();
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const visibleIds = (): string[] => {
    if (!container.isConnected || document.visibilityState !== 'visible') return [];
    const bounds = container.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom);
    const left = Math.max(0, bounds.left);
    const right = Math.min(window.innerWidth, bounds.right);
    if (bottom <= top || right <= left) return [];
    return Array.from(container.querySelectorAll<HTMLElement>('[data-aegis-message-id]'))
      .filter((element) => {
        const id = element.dataset.aegisMessageId!;
        if (!messageIds.has(id) || acknowledged.has(id) || !canRead(id)) return false;
        const rect = element.getBoundingClientRect();
        const visibleHeight = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
        const visibleWidth = Math.min(rect.right, right) - Math.max(rect.left, left);
        return rect.height > 0 && visibleWidth > 0 && visibleHeight >= Math.min(24, rect.height);
      })
      .map((element) => element.dataset.aegisMessageId!)
      .slice(0, 250);
  };

  const schedule = (delay = 250) => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, delay);
  };
  const flush = async () => {
    if (disposed || inFlight) return;
    const ids = visibleIds();
    if (!ids.length) return;
    inFlight = true;
    let retryDelay = 250;
    try {
      await acknowledge(ids);
      ids.forEach((id) => acknowledged.add(id));
    } catch {
      // Aucun faux succès : réessayer seulement les bulles encore visibles.
      retryDelay = 5_000;
    } finally {
      inFlight = false;
      schedule(retryDelay);
    }
  };
  const onChange = () => schedule();
  container.addEventListener('scroll', onChange, { passive: true });
  window.addEventListener('resize', onChange);
  window.addEventListener('online', onChange);
  document.addEventListener('visibilitychange', onChange);
  const observer = typeof IntersectionObserver === 'undefined' ? null
    : new IntersectionObserver(onChange, { root: null, threshold: [0, 0.5, 1] });
  container.querySelectorAll('[data-aegis-message-id]').forEach((element) => observer?.observe(element));
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    observer?.disconnect();
    container.removeEventListener('scroll', onChange);
    window.removeEventListener('resize', onChange);
    window.removeEventListener('online', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}
