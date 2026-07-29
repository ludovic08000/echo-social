import { supabase } from '@/integrations/supabase/client';

export type SetupPinResult = 'ok' | 'no_master_key' | 'invalid_pin' | 'error';

/**
 * Compatibility adapter. Aegis PINs are local-only and never wrap a server
 * recovery secret. Any legacy server PIN row is removed opportunistically.
 */
export async function setupPersistentBackupPin(
  pin: string,
  userId: string,
): Promise<SetupPinResult> {
  if (!/^\d{6}$/.test(pin)) return 'invalid_pin';
  try {
    await supabase.from('backup_pin_state' as never).delete().eq('user_id', userId);
  } catch {
    // The local PIN remains valid even when legacy cleanup is unavailable.
  }
  return 'ok';
}
