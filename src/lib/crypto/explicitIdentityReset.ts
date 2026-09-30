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
  if (userError || !user?.id) return fail('not_authenticated');

  const before = await inspectAccountCryptoState(user.id);
  if (before.state === 'INCONSISTENT') return fail('inspection_failed');
  if (before.hasRestorableBackup) return fail('backup_exists');
  if (before.state !== 'UNRECOVERABLE_SERVER_IDENTITY') return fail('state_not_resettable');

  const keys = await generateIdentityKeys();
  const bundle = await exportPublicKeyBundle(keys);

  // La preuve du mot de passe et l'appel au RPC privilégié ont lieu dans la
  // même Edge Function. Une session navigateur volée ne peut donc ni affirmer
  // que la réauthentification a réussi, ni appeler directement le remplacement.
  const { data: resetData, error: resetError } = await supabase.functions.invoke('identity-reset', {
    body: {
      password,
      identity_key: bundle.identityKey,
      signing_key: bundle.signingKey,
      fingerprint: bundle.fingerprint,
      binding_version: bundle.bindingVersion,
      binding_signature: bundle.bindingSignature,
    },
  });

  let resetCode = typeof (resetData as { code?: unknown } | null)?.code === 'string'
    ? (resetData as { code: string }).code
    : null;
  if (!resetCode && resetError) {
    const response = (resetError as { context?: Response }).context;
    if (response) {
      try {
        const payload = await response.clone().json() as { code?: unknown };
        if (typeof payload.code === 'string') resetCode = payload.code;
      } catch {
        // A non-JSON infrastructure error is mapped to the generic failure.
      }
    }
  }

  if (resetError || (resetData as { ok?: boolean } | null)?.ok !== true) {
    if (resetCode === 'INVALID_PASSWORD') return fail('invalid_password');
    if (resetCode === 'NOT_AUTHENTICATED') return fail('not_authenticated');
    if (resetCode === 'RECOVERABLE_BACKUP_EXISTS') return fail('backup_exists');
    return fail('publish_failed');
  }
  if ((resetData as { fingerprint?: unknown }).fingerprint !== bundle.fingerprint) {
    return fail('verification_failed');
  }

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
    // Invariant corrigé : les autorisations d'appareil signées par l'ancienne
    // identité sont effacées côté serveur ; cet appareil doit se ré-autoriser
    // immédiatement sinon le registre reste invalide et bloque les envois.
    window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
      detail: { reason: 'identity_reset' },
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
