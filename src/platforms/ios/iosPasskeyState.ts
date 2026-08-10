/**
 * État de debug des passkeys iOS (mémoire process uniquement).
 * Aucun secret cryptographique n'est stocké ni exposé : seulement des
 * indicateurs d'état et un message d'erreur tronqué.
 */
export interface IosPasskeyDebugState {
  registered: boolean | null;
  lastError: string | null;
  lastRecoveredDeviceId: string | null;
  updatedAt: string | null;
}

let state: IosPasskeyDebugState = {
  registered: null,
  lastError: null,
  lastRecoveredDeviceId: null,
  updatedAt: null,
};

export function recordIosPasskeyEvent(patch: {
  registered?: boolean;
  lastError?: unknown;
  lastRecoveredDeviceId?: string;
}): void {
  state = {
    registered: patch.registered ?? state.registered,
    lastError: patch.lastError === undefined
      ? state.lastError
      : patch.lastError === null
        ? null
        : (patch.lastError instanceof Error ? patch.lastError.message : String(patch.lastError)).slice(0, 300),
    lastRecoveredDeviceId: patch.lastRecoveredDeviceId ?? state.lastRecoveredDeviceId,
    updatedAt: new Date().toISOString(),
  };
}

export function getIosPasskeyDebugState(): IosPasskeyDebugState {
  return { ...state };
}

export function resetIosPasskeyDebugState(): void {
  state = { registered: null, lastError: null, lastRecoveredDeviceId: null, updatedAt: null };
}
