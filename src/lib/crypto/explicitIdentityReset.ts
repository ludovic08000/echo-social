/**
 * Aegis — réinitialisation explicite d'une identité irrécupérable.
 *
 * Invariant : aucune identité n'est jamais remplacée automatiquement. Cette
 * mutation exige une action utilisateur, une vérification du mot de passe du
 * compte, et l'absence totale de sauvegarde restaurable. L'ancienne identité
 * est archivée (is_active = false), jamais supprimée.
 */

import { supabase } from '@/integrations/supabase/client';
import { inspectAccountCryptoState, type AccountCryptoState } from './accountCryptoState';
import {
  exportPublicKeyBundle,
  generateIdentityKeys,
  saveIdentityKeys,
} from './keyManager';
import { initAccountKeySync } from './accountKeyBackup';

export type IdentityResetErrorCode =
  | 'not_authenticated'
  | 'invalid_password'
  | 'state_not_resettable'
  | 'backup_exists'
  | 'inspection_failed'
  | 'publish_failed'
  | 'backup_creation_failed'
  | 'verification_failed'
  | 'already_running';

export interface IdentityResetResult {
  ok: boolean;
  code?: IdentityResetErrorCode;
  message?: string;
  fingerprint?: string;
  state?: AccountCryptoState;
}

let inFlight: Promise<IdentityResetResult> | null = null;

const MESSAGES: Record<IdentityResetErrorCode, string> = {
  not_authenticated: 'Session expirée. Reconnectez-vous puis réessayez.',
  invalid_password: 'Mot de passe incorrect.',
  state_not_resettable:
    "L'état cryptographique de ce compte n'autorise pas de réinitialisation.",
  backup_exists:
    'Une sauvegarde de votre identité existe encore : vous devez la restaurer, pas la remplacer.',
  inspection_failed: "Inspection de l'état cryptographique impossible.",
  publish_failed: "La nouvelle identité n'a pas pu être publiée.",
  backup_creation_failed: "La sauvegarde de la nouvelle Master Key a échoué.",
  verification_failed:
    "La nouvelle identité n'a pas pu être vérifiée. Aucune messagerie n'est déverrouillée.",
  already_running: 'Une réinitialisation est déjà en cours.',
};

function fail(code: IdentityResetErrorCode): IdentityResetResult {
  return { ok: false, code, message: MESSAGES[code] };
}

async function runReset(password: string): Promise<IdentityResetResult> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user?.id || !user.email) return fail('not_authenticated');

  const before = await inspectAccountCryptoState(user.id);
  if (before.state === 'INCONSISTENT') return fail('inspection_failed');
  if (before.hasRestorableBackup) return fail('backup_exists');
  if (before.state !== 'UNRECOVERABLE_SERVER_IDENTITY') return fail('state_not_resettable');

  // Réauthentification explicite : le mot de passe est vérifié par le serveur
  // d'authentification avant toute mutation cryptographique.
  const { error: authError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (authError) return fail('invalid_password');

  const keys = await generateIdentityKeys();
  const bundle = await exportPublicKeyBundle(keys);

  // L'ancienne identité est archivée, jamais supprimée.
  const { error: archiveError } = await supabase
    .from('user_public_keys' as never)
    .update({ is_active: false, updated_at: new Date().toISOString() } as never)
    .eq('user_id', user.id)
    .eq('is_active', true);
  if (archiveError) return fail('publish_failed');

  const { error: publishError } = await supabase
    .from('user_public_keys' as never)
    .insert({
      user_id: user.id,
      identity_key: bundle.identityKey,
      signing_key: bundle.signingKey,
      fingerprint: bundle.fingerprint,
      identity_binding_version: bundle.bindingVersion,
      identity_binding_signature: bundle.bindingSignature,
      kem_type: 'X25519',
      is_active: true,
      updated_at: new Date().toISOString(),
    } as never);
  if (publishError) return fail('publish_failed');

  await saveIdentityKeys(user.id, keys);

  const backupStatus = await initAccountKeySync(password, user.id);
  if (backupStatus !== 'local_ok' && backupStatus !== 'restored') {
    return fail('backup_creation_failed');
  }

  const after = await inspectAccountCryptoState(user.id);
  if (after.state !== 'READY' || !after.hasAccountBackup) return fail('verification_failed');

  try {
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { status: 'identity_reset', userId: user.id, fingerprint: bundle.fingerprint },
    }));
  } catch { /* la diffusion d'événement est best-effort */ }

  return { ok: true, fingerprint: bundle.fingerprint, state: after.state };
}

/**
 * Point d'entrée unique de la réinitialisation. Single-flight : un double clic
 * ne peut jamais produire deux identités.
 */
export function resetUnrecoverableIdentityWithPassword(
  password: string,
): Promise<IdentityResetResult> {
  if (inFlight) return Promise.resolve(fail('already_running'));
  if (!password) return Promise.resolve(fail('invalid_password'));

  inFlight = runReset(password)
    .catch((error): IdentityResetResult => ({
      ok: false,
      code: 'verification_failed',
      message: error instanceof Error ? error.message : MESSAGES.verification_failed,
    }))
    .finally(() => { inFlight = null; });

  return inFlight;
}

export const __test__ = { MESSAGES };
