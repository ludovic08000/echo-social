import { supabase } from '@/integrations/supabase/client';
import { exportPublicKeyBundle, type IdentityKeyPair } from './keyManager';
import { refreshSignedPrekeyIfNeeded } from './x3dh';
import { resolveUserIdentity } from './identityRecovery';
import { createSecureBackupVault, hasSecureBackupVault } from './secureBackupVault';

const BOOTSTRAP_TTL_MS = 30_000;
const attempts = new Map<string, Promise<void>>();
const lastSuccessAt = new Map<string, number>();

async function publishIdentity(userId: string, keys: IdentityKeyPair): Promise<void> {
  const bundle = await exportPublicKeyBundle(keys);

  const { error } = await supabase
    .from('user_public_keys')
    .upsert({
      user_id: userId,
      identity_key: bundle.identityKey,
      signing_key: bundle.signingKey,
      fingerprint: bundle.fingerprint,
      kem_type: 'X25519',
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,is_active' });

  if (error) throw error;

  try {
    await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
  } catch (error) {
    console.warn('[E2EE][IDENTITY] signed-prekey refresh skipped', error);
  }

  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-ready', {
      detail: { userId, fingerprint: bundle.fingerprint },
    }));
  } catch {}

  console.info('[E2EE][IDENTITY] key assigned and published', {
    userId,
    fingerprint: bundle.fingerprint,
  });
}

async function ensureEncryptedBackupVault(userId: string) {
  try {
    const exists = await hasSecureBackupVault(userId);
    if (exists) return;

    const backup = await createSecureBackupVault(userId);
    if (!backup) return;

    try {
      window.dispatchEvent(new CustomEvent('forsure-e2ee-backup-created', {
        detail: {
          userId,
          fingerprint: backup.fingerprint,
          recoveryKey: backup.recoveryKey,
        },
      }));
    } catch {}

    console.info('[E2EE][BACKUP] encrypted recovery vault created');
  } catch (error) {
    console.warn('[E2EE][BACKUP] vault creation skipped', error);
  }
}

export async function ensureUserE2EEIdentity(userId: string): Promise<void> {
  if (!userId) return;

  const last = lastSuccessAt.get(userId) || 0;
  if (Date.now() - last < BOOTSTRAP_TTL_MS) return;

  const existing = attempts.get(userId);
  if (existing) return existing;

  const attempt = (async () => {
    const { keys, mode } = await resolveUserIdentity(userId);
    await publishIdentity(userId, keys);
    await ensureEncryptedBackupVault(userId);

    lastSuccessAt.set(userId, Date.now());

    if (mode === 'new_epoch') {
      try {
        window.dispatchEvent(new CustomEvent('forsure-e2ee-security-code-changed', {
          detail: { userId, fingerprint: keys.fingerprint },
        }));
      } catch {}
    }

    console.info('[E2EE][IDENTITY] bootstrap complete', { userId, mode });
  })().catch((error) => {
    console.error('[E2EE][IDENTITY] key assignment failed', error);
    throw error;
  }).finally(() => {
    attempts.delete(userId);
  });

  attempts.set(userId, attempt);
  return attempt;
}

export function startIdentityBootstrap(): void {
  void supabase.auth.getSession().then(({ data }) => {
    const userId = data.session?.user?.id;
    if (userId) void ensureUserE2EEIdentity(userId);
  }).catch(() => {});

  supabase.auth.onAuthStateChange((_event, session) => {
    const userId = session?.user?.id;
    if (userId) setTimeout(() => void ensureUserE2EEIdentity(userId), 0);
  });

  window.addEventListener('forsure-e2ee-needs-identity', (event) => {
    const detail = (event as CustomEvent<{ userId?: string }>).detail;
    const userId = detail?.userId;
    if (userId) void ensureUserE2EEIdentity(userId);
  });
}
