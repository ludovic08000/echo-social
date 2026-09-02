export type MatrixConfig = {
  enabled: boolean;
  homeserverUrl: string;
  sessionFunctionName: string;
};

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function getMatrixConfig(
  env: Record<string, string | boolean | undefined> = import.meta.env,
): MatrixConfig {
  const homeserverUrl = normalizeUrl(String(env.VITE_MATRIX_HOMESERVER_URL ?? ''));
  const explicitlyEnabled = String(env.VITE_MATRIX_ENABLED ?? '').toLowerCase() === 'true';

  return {
    // Aegis remains authoritative unless both settings are deliberately present.
    enabled: explicitlyEnabled && homeserverUrl.length > 0,
    homeserverUrl,
    sessionFunctionName: String(env.VITE_MATRIX_SESSION_FUNCTION ?? 'matrix-session').trim(),
  };
}

