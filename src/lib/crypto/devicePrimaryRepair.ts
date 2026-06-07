import { supabase } from '@/integrations/supabase/client';

export interface PrimaryRepairResult {
  ok: boolean;
  changed: boolean;
  code: string;
  error?: string;
}

function emitDeviceListInvalidated(userId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('forsure:e2ee-device-list-invalidated', {
    detail: { userId, source: 'primary-repair' },
  }));
}

async function republishSignedList(userId: string, deviceId: string): Promise<void> {
  emitDeviceListInvalidated(userId);
  try {
    const { publishOwnSignedDeviceList } = await import('./signedDeviceList');
    await publishOwnSignedDeviceList({ signerDeviceId: deviceId });
  } catch (err) {
    console.warn('[devicePrimaryRepair] signed device list republish skipped', err);
  }
}

async function fallbackEnsurePrimary(userId: string, deviceId: string): Promise<PrimaryRepairResult> {
  const { data, error } = await supabase
    .from('user_devices' as any)
    .select('device_id,is_active,revoked_at,is_primary,device_public_key')
    .eq('user_id', userId);

  if (error) return { ok: false, changed: false, code: 'DEVICE_PRIMARY_LOOKUP_FAILED', error: error.message };

  const rows = (data ?? []) as Array<{
    device_id: string;
    is_active: boolean | null;
    revoked_at: string | null;
    is_primary: boolean | null;
    device_public_key: string | null;
  }>;

  const active = rows.filter(row =>
    row.is_active === true &&
    !row.revoked_at &&
    typeof row.device_public_key === 'string' &&
    row.device_public_key.trim().length > 0,
  );
  const current = active.find(row => row.device_id === deviceId);
  if (!current) return { ok: false, changed: false, code: 'CURRENT_DEVICE_NOT_ACTIVE' };
  if (current.is_primary === true) return { ok: true, changed: false, code: 'PRIMARY_ALREADY_CURRENT' };
  if (active.some(row => row.is_primary === true)) return { ok: true, changed: false, code: 'PRIMARY_ALREADY_EXISTS' };

  // Clear stale primary flags first: the DB unique index is keyed on revoked_at,
  // so an inactive-but-not-revoked old primary can block the fresh iOS device.
  await supabase
    .from('user_devices' as any)
    .update({ is_primary: false } as any)
    .eq('user_id', userId)
    .eq('is_primary', true)
    .neq('device_id', deviceId);

  const { error: promoteErr } = await supabase
    .from('user_devices' as any)
    .update({ is_primary: true, last_seen_at: new Date().toISOString() } as any)
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .eq('is_active', true)
    .is('revoked_at', null);

  if (promoteErr) return { ok: false, changed: false, code: 'DEVICE_PRIMARY_PROMOTE_FAILED', error: promoteErr.message };

  try {
    await supabase
      .from('user_device_signatures' as any)
      .update({ revoked_at: new Date().toISOString() } as any)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .neq('primary_device_id', deviceId);
  } catch {
    // Non-fatal: old signatures are ignored if the active primary is repaired.
  }

  await republishSignedList(userId, deviceId);
  return { ok: true, changed: true, code: 'PRIMARY_PROMOTED_FALLBACK' };
}

export async function ensureCurrentDevicePrimary(
  userId: string,
  deviceId: string,
): Promise<PrimaryRepairResult> {
  if (!userId || !deviceId || deviceId.length < 8) {
    return { ok: false, changed: false, code: 'INVALID_INPUT' };
  }

  try {
    const { data, error } = await (supabase as any).rpc('ensure_current_device_primary', {
      p_device_id: deviceId,
    });

    if (!error && data?.ok === true) {
      const changed = data.code === 'PRIMARY_PROMOTED';
      if (changed) await republishSignedList(userId, deviceId);
      return { ok: true, changed, code: String(data.code ?? 'OK') };
    }

    if (error && !/function .*ensure_current_device_primary|schema cache|not found/i.test(error.message ?? '')) {
      return { ok: false, changed: false, code: 'DEVICE_PRIMARY_RPC_FAILED', error: error.message };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/ensure_current_device_primary|schema cache|not found/i.test(message)) {
      return { ok: false, changed: false, code: 'DEVICE_PRIMARY_RPC_THROWN', error: message };
    }
  }

  return fallbackEnsurePrimary(userId, deviceId);
}
