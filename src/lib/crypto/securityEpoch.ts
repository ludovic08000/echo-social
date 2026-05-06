import { supabase } from '@/integrations/supabase/client';

const LOCAL_EPOCH_KEY = 'forsure-e2ee-identity-epoch:';

export interface SecurityEpochRecord {
  userId: string;
  epoch: number;
  fingerprint: string;
  createdAt: string;
  reason: 'initial' | 'restore' | 'new_identity' | 'manual_rotation' | 'device_loss';
}

function localKey(userId: string) {
  return `${LOCAL_EPOCH_KEY}${userId}`;
}

export function getLocalSecurityEpoch(userId: string): number {
  const raw = localStorage.getItem(localKey(userId));
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function setLocalSecurityEpoch(userId: string, epoch: number): void {
  localStorage.setItem(localKey(userId), String(Math.max(1, Math.floor(epoch))));
}

export async function fetchServerSecurityEpoch(userId: string): Promise<number> {
  const { data } = await supabase
    .from('user_public_keys')
    .select('identity_epoch')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  const epoch = Number((data as any)?.identity_epoch || 1);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : 1;
}

export async function bumpSecurityEpoch(
  userId: string,
  fingerprint: string,
  reason: SecurityEpochRecord['reason'],
): Promise<number> {
  const current = Math.max(getLocalSecurityEpoch(userId), await fetchServerSecurityEpoch(userId).catch(() => 1));
  const next = current + 1;
  setLocalSecurityEpoch(userId, next);

  try {
    await supabase
      .from('user_identity_epochs' as any)
      .insert({
        user_id: userId,
        epoch: next,
        fingerprint,
        reason,
        created_at: new Date().toISOString(),
      });
  } catch (error) {
    console.warn('[E2EE][EPOCH] epoch history insert skipped', error);
  }

  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-security-epoch-changed', {
      detail: { userId, epoch: next, fingerprint, reason },
    }));
  } catch {}

  return next;
}

export async function ensureSecurityEpoch(userId: string, fingerprint: string): Promise<number> {
  const local = getLocalSecurityEpoch(userId);
  const remote = await fetchServerSecurityEpoch(userId).catch(() => local);
  const epoch = Math.max(local, remote, 1);
  setLocalSecurityEpoch(userId, epoch);

  try {
    await supabase
      .from('user_public_keys')
      .update({ identity_epoch: epoch, updated_at: new Date().toISOString() } as any)
      .eq('user_id', userId)
      .eq('is_active', true);
  } catch (error) {
    console.warn('[E2EE][EPOCH] public key epoch update skipped', error);
  }

  return epoch;
}

export function attachEpochToEnvelope<T extends Record<string, unknown>>(envelope: T, userId: string): T & { identityEpoch: number } {
  return { ...envelope, identityEpoch: getLocalSecurityEpoch(userId) };
}

export function isEnvelopeEpochStale(localUserId: string, envelopeEpoch?: number | null): boolean {
  if (!envelopeEpoch) return false;
  return envelopeEpoch < getLocalSecurityEpoch(localUserId);
}
