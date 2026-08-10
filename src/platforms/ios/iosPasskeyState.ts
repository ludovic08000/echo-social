import {
  recordIosDiagnostic,
  recordIosDiagnosticError,
} from '@/platforms/ios/iosSupabaseDiagnostics';

/**
 * État de debug des passkeys iOS.
 * Aucun secret cryptographique n'est stocké ni exposé : seulement des
 * indicateurs d'état et un message d'erreur tronqué. Les transitions sont
 * également persistées de façon sanitizée dans Supabase pour le diagnostic.
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
  const normalizedError = patch.lastError === undefined
    ? state.lastError
    : patch.lastError === null
      ? null
      : (patch.lastError instanceof Error ? patch.lastError.message : String(patch.lastError)).slice(0, 300);

  state = {
    registered: patch.registered ?? state.registered,
    lastError: normalizedError,
    lastRecoveredDeviceId: patch.lastRecoveredDeviceId ?? state.lastRecoveredDeviceId,
    updatedAt: new Date().toISOString(),
  };

  const metadata = {
    source: 'iosPasskeyState',
    registered: state.registered,
    outcome: state.lastError ? 'error' : 'ok',
  };

  if (patch.lastError !== undefined && patch.lastError !== null) {
    recordIosDiagnosticError({
      event: 'ios.passkey.state.error',
      error: patch.lastError,
      deviceId: state.lastRecoveredDeviceId,
      metadata,
    });
    return;
  }

  recordIosDiagnostic({
    event: 'ios.passkey.state',
    severity: 'info',
    deviceId: state.lastRecoveredDeviceId,
    metadata,
  });
}

export function getIosPasskeyDebugState(): IosPasskeyDebugState {
  return { ...state };
}

export function resetIosPasskeyDebugState(): void {
  state = { registered: null, lastError: null, lastRecoveredDeviceId: null, updatedAt: null };
  recordIosDiagnostic({
    event: 'ios.passkey.state.reset',
    severity: 'info',
    metadata: { source: 'iosPasskeyState', outcome: 'reset' },
  });
}
