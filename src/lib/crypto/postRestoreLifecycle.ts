import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, hydrateDeviceId } from '@/lib/messaging/currentDevice';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import { provisionLibsignalDevice } from './libsignalProvisioning';

export type PostRestoreSource = 'pin' | 'recovery_key' | 'passkey' | 'password' | 'unknown';

async function bumpKeysEpochBestEffort(userId: string): Promise<number | null> {
  try {
    const { data, error } = await (supabase as any).rpc('bump_keys_epoch', { p_user_id: userId });
    if (!error && typeof data === 'number') return data;
  } catch {}

  try {
    const { data } = await (supabase as any)
      .from('user_public_keys')
      .select('keys_epoch')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    const next = Number(data?.keys_epoch ?? 0) + 1;
    const { error } = await (supabase as any)
      .from('user_public_keys')
      .update({ keys_epoch: next, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_active', true);
    if (!error) return next;
  } catch {}

  return null;
}

async function revalidateCurrentDevicePrekeys(userId: string, deviceId: string): Promise<void> {
  await getOrCreateDeviceIdentity(userId, deviceId);
  await provisionLibsignalDevice(userId, deviceId);
}

export async function runPostRestoreLifecycle(
  userId: string,
  source: PostRestoreSource = 'unknown',
): Promise<{ ok: true; deviceId: string; keysEpoch: number | null } | { ok: false; reason: string }> {
  try {
    const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
    const keysEpoch = await bumpKeysEpochBestEffort(userId);

    await revalidateCurrentDevicePrekeys(userId, deviceId);
    try {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-post-restore-complete', {
        detail: { userId, deviceId, source, keysEpoch },
      }));
      window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
        detail: { source: `post_restore_${source}`, keysEpoch },
      }));
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
        detail: { source: `post_restore_${source}`, keysEpoch },
      }));
      window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
        detail: { userId, deviceId, source: `post_restore_${source}` },
      }));
    } catch {}

    return { ok: true, deviceId, keysEpoch };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
