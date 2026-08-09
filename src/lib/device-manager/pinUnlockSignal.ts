/**
 * Signal léger d'état PIN, sans monter le hook complet `useChatPin`.
 *
 * Invariant : le runtime crypto n'est autorisé qu'après un déverrouillage
 * explicite. La lecture ne crée jamais d'état, elle observe uniquement.
 */

const PIN_STATE_CHANGED_EVENT = 'forsure:chat-pin-state-changed';
const SESSION_KEY = 'forsure-pin-unlocked';

export function readPinUnlocked(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return sessionStorage.getItem(SESSION_KEY) === userId;
  } catch {
    return false;
  }
}

export function subscribePinUnlocked(
  userId: string | null | undefined,
  listener: (unlocked: boolean) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const emit = () => listener(readPinUnlocked(userId));

  const onPinState = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: string; unlocked?: boolean }>).detail;
    if (detail?.userId && userId && detail.userId !== userId) return;
    if (typeof detail?.unlocked === 'boolean') {
      listener(detail.unlocked && !!userId);
      return;
    }
    emit();
  };

  window.addEventListener(PIN_STATE_CHANGED_EVENT, onPinState);
  window.addEventListener('forsure-keys-unlocked', emit);
  window.addEventListener('forsure-messaging-locked', emit);

  return () => {
    window.removeEventListener(PIN_STATE_CHANGED_EVENT, onPinState);
    window.removeEventListener('forsure-keys-unlocked', emit);
    window.removeEventListener('forsure-messaging-locked', emit);
  };
}

export const __test__ = { PIN_STATE_CHANGED_EVENT, SESSION_KEY };
