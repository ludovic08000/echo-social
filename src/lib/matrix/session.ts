import { supabase } from '@/integrations/supabase/client';
import { getMatrixConfig } from './config';

export type MatrixSession = {
  accessToken: string;
  deviceId: string;
  refreshToken?: string;
  userId: string;
};

type MatrixSessionResponse = {
  access_token?: unknown;
  device_id?: unknown;
  refresh_token?: unknown;
  user_id?: unknown;
};

const INSTALLATION_ID_KEY = 'forsure:matrix:installation-id:v1';

function getInstallationId(): string {
  const existing = window.localStorage.getItem(INSTALLATION_ID_KEY);
  if (existing && /^[a-zA-Z0-9_-]{16,128}$/.test(existing)) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(INSTALLATION_ID_KEY, created);
  return created;
}

function getDeviceName(): string {
  const platform = navigator.platform || 'Web';
  return `${platform} · ${navigator.userAgent.includes('Mobile') ? 'Mobile' : 'Navigateur'}`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`MATRIX_SESSION_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

/**
 * Exchanges the existing Supabase session for a short-lived Matrix login.
 * The Supabase password is never exposed to Matrix or stored in the browser.
 */
export async function requestMatrixSession(): Promise<MatrixSession> {
  const config = getMatrixConfig();
  if (!config.enabled) throw new Error('MATRIX_DISABLED');

  const { data, error } = await supabase.functions.invoke<MatrixSessionResponse>(
    config.sessionFunctionName,
    {
      body: {
        installation_id: getInstallationId(),
        device_name: getDeviceName(),
      },
    },
  );
  if (error) throw new Error(`MATRIX_SESSION_EXCHANGE_FAILED: ${error.message}`);

  return {
    accessToken: requireNonEmptyString(data?.access_token, 'access_token'),
    deviceId: requireNonEmptyString(data?.device_id, 'device_id'),
    refreshToken: typeof data?.refresh_token === 'string' ? data.refresh_token : undefined,
    userId: requireNonEmptyString(data?.user_id, 'user_id'),
  };
}
