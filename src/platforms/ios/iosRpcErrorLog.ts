import { recordIosDiagnosticError } from '@/platforms/ios/iosSupabaseDiagnostics';

/**
 * Dernière erreur RPC observée par l'adaptateur iOS.
 * Le cache mémoire reste disponible pour l'UI et une copie sanitizée est
 * persistée dans Supabase pour rendre les échecs iOS observables à distance.
 */
export interface IosRpcErrorEntry {
  operation: string;
  message: string;
  at: string;
}

let lastError: IosRpcErrorEntry | null = null;

function diagnosticEvent(operation: string): string {
  const normalized = operation
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 78);
  return `${normalized.startsWith('ios.') ? normalized : 'ios.rpc'}.error`;
}

export function recordIosRpcError(operation: string, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  lastError = {
    operation,
    message,
    at: new Date().toISOString(),
  };

  recordIosDiagnosticError({
    event: diagnosticEvent(operation),
    error,
    metadata: {
      source: 'iosRpcErrorLog',
      stage: operation.slice(0, 180),
    },
  });
}

export function clearIosRpcError(): void {
  lastError = null;
}

export function getLastIosRpcError(): IosRpcErrorEntry | null {
  return lastError;
}
