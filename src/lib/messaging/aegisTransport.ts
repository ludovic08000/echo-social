import { supabase } from '@/integrations/supabase/client';

export type AegisRpcError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
} | null;

export type AegisRpcResponse<T> = {
  data: T | null;
  error: AegisRpcError;
};

type AegisRpcName =
  | 'aegis_send_message'
  | 'aegis_sync_device'
  | 'aegis_ack_device_messages';

type BrowserLocation = Pick<Location, 'hostname' | 'origin'>;

function validateGatewayUrl(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  if (
    !normalized.startsWith('https://') &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)
  ) {
    throw new Error('AEGIS_SERVER_HTTPS_REQUIRED');
  }
  return normalized;
}

/**
 * Vercel Preview builds contain the production gateway URL at build time.
 * Calling it from `*.vercel.app` would be cross-origin and intentionally denied
 * by the production CORS allowlist. Preview deployments expose the exact same
 * `/v1/rpc/*` functions, so they must use their own origin instead.
 */
export function resolveAegisGatewayUrl(
  configuredValue: unknown,
  browserLocation: BrowserLocation | null = typeof window !== 'undefined'
    ? window.location
    : null,
): string {
  const value = String(configuredValue ?? '').trim();
  if (!value) return '';

  const configured = validateGatewayUrl(value);
  const hostname = browserLocation?.hostname?.toLowerCase() ?? '';
  if (hostname.endsWith('.vercel.app')) {
    return validateGatewayUrl(browserLocation?.origin ?? '');
  }
  return configured;
}

function gatewayUrl(): string {
  return resolveAegisGatewayUrl(import.meta.env.VITE_AEGIS_SERVER_URL);
}

function gatewayCredentials(baseUrl: string): RequestCredentials {
  if (typeof window === 'undefined') return 'omit';
  try {
    return new URL(baseUrl).origin === window.location.origin
      ? 'same-origin'
      : 'omit';
  } catch {
    return 'omit';
  }
}

async function callGateway<T>(
  name: AegisRpcName,
  args: Record<string, unknown>,
): Promise<AegisRpcResponse<T>> {
  const baseUrl = gatewayUrl();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { data: null, error: { code: 'NOT_AUTHENTICATED', message: 'Missing session.' } };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl}/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
      credentials: gatewayCredentials(baseUrl),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: T;
      error?: AegisRpcError;
    };
    if (!response.ok) {
      return {
        data: null,
        error: payload.error ?? {
          code: `AEGIS_HTTP_${response.status}`,
          message: `Aegis gateway rejected the request (${response.status}).`,
        },
      };
    }
    return { data: payload.data ?? null, error: payload.error ?? null };
  } catch (error) {
    return {
      data: null,
      error: {
        code: 'AEGIS_GATEWAY_UNREACHABLE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    window.clearTimeout(timer);
  }
}

async function callSupabase<T>(
  name: AegisRpcName,
  args: Record<string, unknown>,
): Promise<AegisRpcResponse<T>> {
  // Invariant : l'appel RPC conserve toujours son receveur SDK. Détacher
  // `supabase.rpc` détruit son contexte interne (`this.rest`) sur certains
  // bundles navigateur et bloque l'envoi avant toute transaction Aegis.
  //
  // The generated Database type is refreshed only after the migration reaches
  // the cloud database. The cast keeps this additive branch type-safe until
  // that schema regeneration occurs; the public wrapper remains strongly typed.
  const response = await supabase.rpc(name as never, args as never);
  return {
    data: (response.data as T | null) ?? null,
    error: response.error ?? null,
  };
}

/**
 * Stable Aegis protocol boundary.
 *
 * Today it calls Supabase RPC directly. Setting VITE_AEGIS_SERVER_URL routes
 * the exact same encrypted protocol through the VPS gateway, without changing
 * UI, outbox, device identities or ciphertext formats.
 */
export function callAegisServer<T>(
  name: AegisRpcName,
  args: Record<string, unknown>,
): Promise<AegisRpcResponse<T>> {
  return gatewayUrl()
    ? callGateway<T>(name, args)
    : callSupabase<T>(name, args);
}

export function getAegisTransportKind(): 'gateway' | 'supabase' {
  return gatewayUrl() ? 'gateway' : 'supabase';
}
