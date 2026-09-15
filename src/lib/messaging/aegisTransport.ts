import { supabase } from '@/integrations/supabase/client';
import { traceE2EE } from './e2eeTrace';

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
  traceE2EE({ direction: 'send', component: 'aegis_transport', stage: 'AUTH_TOKEN_PRESENT',
    transport: 'aegis_server', outcome: session?.access_token ? 'ok' : 'error',
    errorCode: session?.access_token ? undefined : 'NOT_AUTHENTICATED' });
  if (!session?.access_token) {
    return { data: null, error: { code: 'NOT_AUTHENTICATED', message: 'Missing session.' } };
  }
  // La date locale est indicative. Seul le serveur vérifie le JWT ; aucune donnée du JWT n'est loguée.
  traceE2EE({ direction: 'send', component: 'aegis_transport', stage: 'AUTH_TOKEN_LOCAL_EXPIRY',
    transport: 'aegis_server', outcome: !session.expires_at ? 'skip' : session.expires_at * 1000 > Date.now() ? 'ok' : 'error',
    errorCode: session.expires_at && session.expires_at * 1000 <= Date.now() ? 'AUTH_TOKEN_EXPIRED' : undefined });

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
    traceE2EE({ direction: name === 'aegis_sync_device' ? 'receive' : 'send', component: 'aegis_transport',
      stage: `${name}.HTTP_RESPONSE`, transport: 'aegis_server', outcome: response.ok ? 'ok' : 'error',
      diagnosticId: response.headers.get('x-aegis-diagnostic-id') ?? undefined,
      errorCode: response.ok ? undefined : `AEGIS_HTTP_${response.status}` });
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
export async function callAegisServer<T>(
  name: AegisRpcName,
  args: Record<string, unknown>,
): Promise<AegisRpcResponse<T>> {
  const context = { direction: name === 'aegis_sync_device' ? 'receive' as const : 'send' as const,
    component: 'aegis_transport', stage: name, transport: gatewayUrl() ? 'aegis_server' as const : 'supabase' as const };
  const started = Date.now();
  traceE2EE({ ...context, outcome: 'start' });
  try {
    const response = context.transport === 'aegis_server' ? await callGateway<T>(name, args) : await callSupabase<T>(name, args);
    traceE2EE({ ...context, outcome: response.error ? 'error' : 'ok', blockMs: Date.now() - started,
      errorCode: response.error?.code ?? undefined });
    return response;
  } catch (error) {
    traceE2EE({ ...context, outcome: 'error', blockMs: Date.now() - started,
      errorCode: error instanceof Error ? error.message : 'E_UNKNOWN' });
    throw error;
  }
}

export function getAegisTransportKind(): 'gateway' | 'supabase' {
  return gatewayUrl() ? 'gateway' : 'supabase';
}
