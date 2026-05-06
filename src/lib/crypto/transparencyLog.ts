import { supabase } from '@/integrations/supabase/client';

export type TransparencyEventType =
  | 'identity_bootstrap'
  | 'identity_restored'
  | 'identity_epoch_changed'
  | 'device_linked'
  | 'device_revoked'
  | 'backup_created'
  | 'backup_rotated'
  | 'sender_certificate_issued'
  | 'sealed_sender_event'
  | 'security_warning';

export async function appendTransparencyLog(params: {
  userId: string;
  eventType: TransparencyEventType;
  fingerprint?: string | null;
  identityEpoch?: number | null;
  deviceId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabase.from('e2ee_transparency_log' as any).insert({
      user_id: params.userId,
      event_type: params.eventType,
      fingerprint: params.fingerprint || null,
      identity_epoch: params.identityEpoch || null,
      device_id: params.deviceId || null,
      payload: params.payload || {},
    });
  } catch (error) {
    console.warn('[E2EE][TRANSPARENCY] append skipped', error);
  }
}

export async function fetchTransparencyLog(userId: string, limit = 100) {
  const { data } = await supabase
    .from('e2ee_transparency_log' as any)
    .select('event_type, fingerprint, identity_epoch, device_id, payload, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}
