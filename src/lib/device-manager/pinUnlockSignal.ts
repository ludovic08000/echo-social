/**
 * Invariant cryptographique : le déverrouillage PIN est une étape obligatoire
 * du cycle de vie, placée après l'approbation serveur et avant le binding, la
 * préparation des clés et la synchronisation de compte. Aucun chemin PIN-first
 * ni contournement n'est autorisé.
 */

const PIN_STATE_CHANGED_EVENT = 'forsure:chat-pin-state-changed';
const SESSION_KEY = 'forsure-pin-unlocked';
const PIN_PROTECTION_ENABLED = true;

export function readPinUnlocked(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (!PIN_PROTECTION_ENABLED) return true;
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

  if (!PIN_PROTECTION_ENABLED) {
    listener(!!userId);
    return () => undefined;
  }

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

export const __test__ = { PIN_STATE_CHANGED_EVENT, SESSION_KEY, PIN_PROTECTION_ENABLED };
