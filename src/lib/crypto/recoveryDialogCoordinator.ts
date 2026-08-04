/**
 * Coordinateur d'affichage des écrans de récupération/réinitialisation.
 *
 * Invariant : un seul écran central peut être visible à la fois, quelle que
 * soit la source de l'événement (signed_in, session_restored,
 * identity_continuity_guard, identity_recovery_required,
 * server_identity_without_local_identity).
 */

type Listener = (owner: string | null) => void;

let currentOwner: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => {
    try { listener(currentOwner); } catch { /* un abonné cassé ne bloque pas les autres */ }
  });
}

/** Prend le verrou d'affichage. Retourne false si un autre écran est déjà ouvert. */
export function acquireRecoveryDialog(owner: string): boolean {
  if (currentOwner && currentOwner !== owner) return false;
  if (currentOwner === owner) return true;
  currentOwner = owner;
  notify();
  return true;
}

export function releaseRecoveryDialog(owner: string): void {
  if (currentOwner !== owner) return;
  currentOwner = null;
  notify();
}

export function getRecoveryDialogOwner(): string | null {
  return currentOwner;
}

export function subscribeRecoveryDialog(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const __test__ = {
  reset(): void { currentOwner = null; listeners.clear(); },
};
