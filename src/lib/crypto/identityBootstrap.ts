import { supabase } from '@/integrations/supabase/client';
import { exportPublicKeyBundle, type IdentityKeyPair } from './keyManager';
import { refreshSignedPrekeyIfNeeded } from './x3dh';
import { resolveUserIdentity } from './identityRecovery';
import { ensureServerCryptoState, markServerCryptoReady } from './serverCryptoState';
import { appendTransparencyLog } from './transparencyLog';

const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const attempts = new Map<string, Promise<void>>();
const localAttempts = new Map<string, Promise<{ keys: IdentityKeyPair; mode: 'local' | 'restored' | 'new_epoch' }>>();
const lastSuccessAt = new Map<string, number>();

interface EnsureIdentityOptions {
  /**
   * Fast path for message sending: wait only for local identity material.
   * Server publication and SPK maintenance continue in the background.
   */
  waitForMaintenance?: boolean;
}

async function resolveLocalIdentityOnce(userId: string): Promise<{ keys: IdentityKeyPair; mode: 'local' | 'restored' | 'new_epoch' }> {
  const existing = localAttempts.get(userId);
  if (existing) return existing;

  const attempt = resolveUserIdentity(userId)
    .finally(() => {
      localAttempts.delete(userId);
    });
  localAttempts.set(userId, attempt);
  return attempt;
}

async function publishIdentity(userId: string, keys: IdentityKeyPair, options: { refreshSignedPrekey?: boolean } = {}): Promise<void> {
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
    await markServerCryptoReady(bundle.fingerprint);
  } catch (error) {
    console.warn('[E2EE][SERVER_STATE] ready update skipped', error);
  }

  if (options.refreshSignedPrekey !== false) {
    try {
      await refreshSignedPrekeyIfNeeded(userId, keys.signingPrivateKey);
    } catch (error) {
      console.warn('[E2EE][IDENTITY] signed-prekey refresh skipped', error);
    }
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

async function runIdentityMaintenance(
  userId: string,
  keys: IdentityKeyPair,
  mode: 'local' | 'restored' | 'new_epoch',
): Promise<void> {
  try {
    await ensureServerCryptoState();
  } catch (error) {
    console.warn('[E2EE][SERVER_STATE] provisioning skipped', error);
  }

  await publishIdentity(userId, keys);

  lastSuccessAt.set(userId, Date.now());

  // Key Transparency: record the identity binding in the append-only log so the
  // kt-publish-epoch aggregator can include it in a signed Merkle epoch.
  // Best-effort — appendTransparencyLog already swallows its own errors.
  void appendTransparencyLog({
    userId,
    eventType:
      mode === 'restored' ? 'identity_restored'
      : mode === 'new_epoch' ? 'identity_epoch_changed'
      : 'identity_bootstrap',
    fingerprint: keys.fingerprint,
  });

  if (mode === 'new_epoch') {
    try {
      window.dispatchEvent(new CustomEvent('forsure-e2ee-security-code-changed', {
        detail: { userId, fingerprint: keys.fingerprint },
      }));
    } catch {}
  }

  console.info('[E2EE][IDENTITY] bootstrap complete', { userId, mode });
}

function scheduleIdentityMaintenance(
  userId: string,
  keys: IdentityKeyPair,
  mode: 'local' | 'restored' | 'new_epoch',
): void {
  const last = lastSuccessAt.get(userId) || 0;
  if (Date.now() - last < BOOTSTRAP_TTL_MS) return;
  if (attempts.has(userId)) return;

  const attempt = runIdentityMaintenance(userId, keys, mode)
    .catch((error) => {
      console.warn('[E2EE][IDENTITY] background maintenance failed', error);
    })
    .finally(() => {
      attempts.delete(userId);
    });
  attempts.set(userId, attempt);
}

export async function ensureUserE2EEIdentity(userId: string, options: EnsureIdentityOptions = {}): Promise<void> {
  if (!userId) return;

  const waitForMaintenance = options.waitForMaintenance !== false;
  const last = lastSuccessAt.get(userId) || 0;
  if (waitForMaintenance && Date.now() - last < BOOTSTRAP_TTL_MS) return;

  const { keys, mode } = await resolveLocalIdentityOnce(userId);

  if (!waitForMaintenance) {
    scheduleIdentityMaintenance(userId, keys, mode);
    return;
  }

  const existing = attempts.get(userId);
  if (existing) return existing;

  const attempt = runIdentityMaintenance(userId, keys, mode).catch((error) => {
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
