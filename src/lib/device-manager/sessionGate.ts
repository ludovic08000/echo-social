import { supabase } from '@/integrations/supabase/client';

export class DeviceSessionUnavailableError extends Error {
  constructor(message = 'DEVICE_SESSION_UNAVAILABLE') {
    super(message);
    this.name = 'DeviceSessionUnavailableError';
  }
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Device publication must not run during the short auth recovery window where
 * Supabase has not restored its local session yet. This prevents the repeated
 * REST 401s seen during startup/resume.
 */
export async function requireAuthenticatedDeviceSession(
  expectedUserId: string,
  delaysMs: readonly number[] = [0, 250, 750, 1_500],
): Promise<void> {
  let lastError: unknown = null;

  for (const delay of delaysMs) {
    await sleep(delay);
    try {
      let { data, error } = await supabase.auth.getSession();
      if (error) lastError = error;

      if (!data.session) {
        const refreshed = await supabase.auth.refreshSession();
        data = refreshed.data;
        if (refreshed.error) lastError = refreshed.error;
      }

      const sessionUserId = data.session?.user?.id;
      if (sessionUserId === expectedUserId) return;
      if (sessionUserId && sessionUserId !== expectedUserId) {
        throw new DeviceSessionUnavailableError('DEVICE_SESSION_USER_MISMATCH');
      }
    } catch (error) {
      lastError = error;
      if (error instanceof DeviceSessionUnavailableError && error.message.includes('MISMATCH')) {
        throw error;
      }
    }
  }

  console.warn('[DeviceManager] authenticated session unavailable; device write blocked', {
    userId: expectedUserId.slice(0, 8),
    error: lastError instanceof Error ? lastError.message : String(lastError ?? 'none'),
  });
  throw new DeviceSessionUnavailableError();
}
