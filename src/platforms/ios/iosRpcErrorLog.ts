/**
 * Dernière erreur RPC observée par l'adaptateur iOS.
 * Purement diagnostique, en mémoire, jamais de contenu secret.
 */
export interface IosRpcErrorEntry {
  operation: string;
  message: string;
  at: string;
}

let lastError: IosRpcErrorEntry | null = null;

export function recordIosRpcError(operation: string, error: unknown): void {
  lastError = {
    operation,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    at: new Date().toISOString(),
  };
}

export function clearIosRpcError(): void {
  lastError = null;
}

export function getLastIosRpcError(): IosRpcErrorEntry | null {
  return lastError;
}
