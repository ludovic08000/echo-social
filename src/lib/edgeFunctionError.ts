type EdgeFunctionErrorLike = {
  name?: unknown;
  message?: unknown;
  context?: unknown;
};

function payloadMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as { error?: unknown; message?: unknown };
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim();
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  return null;
}

async function responseMessage(context: unknown): Promise<string | null> {
  if (!context || typeof context !== 'object') return null;
  const response = context as {
    clone?: () => { json?: () => Promise<unknown> };
    json?: () => Promise<unknown>;
  };
  const readable = typeof response.clone === 'function' ? response.clone() : response;
  if (typeof readable.json !== 'function') return null;
  try {
    return payloadMessage(await readable.json());
  } catch {
    return null;
  }
}

export async function edgeFunctionErrorMessage(
  error: unknown,
  fallback = 'Erreur IA',
): Promise<string> {
  if (!error || typeof error !== 'object') return fallback;
  const value = error as EdgeFunctionErrorLike;
  const serverMessage = await responseMessage(value.context);
  if (serverMessage) return serverMessage;

  if (value.name === 'FunctionsFetchError') {
    return 'Connexion au service IA impossible. Réessayez.';
  }
  if (value.name === 'FunctionsRelayError') {
    return 'Service IA temporairement indisponible. Réessayez.';
  }

  const message = typeof value.message === 'string' ? value.message.trim() : '';
  if (message && message !== 'Edge Function returned a non-2xx status code') return message;
  return fallback;
}
