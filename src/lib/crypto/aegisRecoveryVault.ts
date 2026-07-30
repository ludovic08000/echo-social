import { supabase } from '@/integrations/supabase/client';
import { openE2EEDB } from './indexedDb';
import { STORE_KEYS, KX_KEY_PARAMS, SIG_KEY_PARAMS } from './constants';
import {
  computeCompositeFingerprintFromBase64,
  loadIdentityKeys,
  saveIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { importKeyFromJWK } from './utils';
import { hardCrypto } from './cryptoIntegrity';
import { runPostRestoreSync } from './postRestoreSync';
import {
  AEGIS_RECOVERY_VERSION,
  decideRecoveryInstall,
  generateAegisRecoveryKey,
  nextRecoveryGeneration,
  normalizeAegisRecoveryKey,
  openAegisRecoveryVault,
  sealAegisRecoveryVault,
  type AegisRecoveryVaultEnvelope,
  type AegisRecoveryVaultPayload,
  type PortableAccountIdentity,
} from './aegisRecoveryProtocol';

const TABLE = 'aegis_recovery_vaults';

interface StoredIdentityRow extends PortableAccountIdentity {
  id: string;
}

interface RecoveryVaultRow {
  protocol_version: number;
  generation: number;
  identity_fingerprint: string;
  kdf_salt: string;
  nonce: string;
  ciphertext: string;
}

export type AegisRecoveryRestoreResult =
  | { status: 'restored' | 'already_present'; fingerprint: string; generation: number }
  | { status: 'not_found' | 'wrong_key' | 'conflict' | 'invalid_vault'; reason?: string };

export interface CreatedAegisRecoveryVault {
  recoveryKey: string;
  fingerprint: string;
  generation: number;
}

function jwkXToBase64(jwk: JsonWebKey): string {
  const x = jwk.x;
  if (typeof x !== 'string' || x.length === 0) throw new Error('INVALID_PUBLIC_JWK');
  const base64 = x.replace(/-/g, '+').replace(/_/g, '/');
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4);
}

async function readPortableIdentity(userId: string): Promise<PortableAccountIdentity | null> {
  const db = await openE2EEDB();
  if (!db.objectStoreNames.contains(STORE_KEYS)) return null;
  const row = await new Promise<StoredIdentityRow | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_KEYS, 'readonly');
    const request = tx.objectStore(STORE_KEYS).get(userId);
    request.onsuccess = () => resolve(request.result as StoredIdentityRow | undefined);
    request.onerror = () => reject(request.error);
  });
  if (!row) return null;
  const computed = await computeCompositeFingerprintFromBase64(
    jwkXToBase64(row.publicKeyJWK),
    jwkXToBase64(row.signingPublicKeyJWK),
  );
  if (computed !== row.fingerprint) throw new Error('LOCAL_IDENTITY_FINGERPRINT_MISMATCH');
  return {
    publicKeyJWK: row.publicKeyJWK,
    privateKeyJWK: row.privateKeyJWK,
    signingPublicKeyJWK: row.signingPublicKeyJWK,
    signingPrivateKeyJWK: row.signingPrivateKeyJWK,
    createdAt: row.createdAt,
    fingerprint: computed,
  };
}

async function importPortableIdentity(identity: PortableAccountIdentity): Promise<IdentityKeyPair> {
  const [publicKey, privateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    importKeyFromJWK(identity.publicKeyJWK, KX_KEY_PARAMS, [], true),
    importKeyFromJWK(identity.privateKeyJWK, KX_KEY_PARAMS, ['deriveBits'], false),
    importKeyFromJWK(identity.signingPublicKeyJWK, SIG_KEY_PARAMS, ['verify'], true),
    importKeyFromJWK(identity.signingPrivateKeyJWK, SIG_KEY_PARAMS, ['sign'], false),
  ]);
  const [identityRaw, signingRaw] = await Promise.all([
    hardCrypto.exportKey('raw', publicKey) as Promise<ArrayBuffer>,
    hardCrypto.exportKey('raw', signingPublicKey) as Promise<ArrayBuffer>,
  ]);
  const toBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const fingerprint = await computeCompositeFingerprintFromBase64(
    toBase64(identityRaw),
    toBase64(signingRaw),
  );
  if (fingerprint !== identity.fingerprint) throw new Error('VAULT_IDENTITY_FINGERPRINT_MISMATCH');
  return {
    publicKey,
    privateKey,
    signingPublicKey,
    signingPrivateKey,
    createdAt: identity.createdAt,
    fingerprint,
    _privJWK: identity.privateKeyJWK,
    _sigPrivJWK: identity.signingPrivateKeyJWK,
  };
}

async function currentServerFingerprint(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_public_keys')
    .select('fingerprint')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data?.fingerprint ?? null;
}

async function fetchVaultRow(userId: string): Promise<RecoveryVaultRow | null> {
  const { data, error } = await supabase
    .from(TABLE as never)
    .select('protocol_version, generation, identity_fingerprint, kdf_salt, nonce, ciphertext')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as RecoveryVaultRow | null;
}

export async function hasAegisRecoveryVault(userId: string): Promise<boolean> {
  return Boolean(await fetchVaultRow(userId));
}

export async function createOrRotateAegisRecoveryVault(userId: string): Promise<CreatedAegisRecoveryVault> {
  const identity = await readPortableIdentity(userId);
  if (!identity) throw new Error('ACCOUNT_IDENTITY_NOT_AVAILABLE');
  const current = await fetchVaultRow(userId);
  const generation = nextRecoveryGeneration(current?.generation);
  const recoveryKey = generateAegisRecoveryKey();
  const payload: AegisRecoveryVaultPayload = {
    protocol: 'aegis-recovery-v1',
    version: AEGIS_RECOVERY_VERSION,
    userId,
    generation,
    createdAt: new Date().toISOString(),
    identity,
  };
  const envelope = await sealAegisRecoveryVault(payload, recoveryKey);
  const { data, error } = await supabase.rpc('write_aegis_recovery_vault' as never, {
    p_protocol_version: envelope.protocolVersion,
    p_generation: envelope.generation,
    p_identity_fingerprint: envelope.identityFingerprint,
    p_kdf_salt: envelope.salt,
    p_nonce: envelope.iv,
    p_ciphertext: envelope.ciphertext,
  } as never);
  if (error) throw error;
  if (Number(data) !== generation) throw new Error('RECOVERY_VAULT_GENERATION_REJECTED');
  return { recoveryKey, fingerprint: identity.fingerprint, generation };
}

export async function restoreAegisRecoveryVault(
  userId: string,
  recoveryKey: string,
): Promise<AegisRecoveryRestoreResult> {
  const row = await fetchVaultRow(userId);
  if (!row) return { status: 'not_found' };
  const envelope: AegisRecoveryVaultEnvelope = {
    protocolVersion: AEGIS_RECOVERY_VERSION,
    generation: row.generation,
    identityFingerprint: row.identity_fingerprint,
    salt: row.kdf_salt,
    iv: row.nonce,
    ciphertext: row.ciphertext,
  };
  let payload: AegisRecoveryVaultPayload;
  try {
    payload = await openAegisRecoveryVault({
      envelope,
      recoveryKey: normalizeAegisRecoveryKey(recoveryKey),
      userId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason === 'INVALID_RECOVERY_KEY'
      ? { status: 'wrong_key', reason }
      : { status: 'wrong_key', reason };
  }

  try {
    const [localIdentity, serverFingerprint] = await Promise.all([
      loadIdentityKeys(userId),
      currentServerFingerprint(userId),
    ]);
    const decision = decideRecoveryInstall({
      vaultFingerprint: payload.identity.fingerprint,
      localFingerprint: localIdentity?.fingerprint,
      serverFingerprint,
    });
    if (decision === 'conflict') {
      return { status: 'conflict', reason: 'IDENTITY_CONTINUITY_CONFLICT' };
    }
    if (decision === 'already_present') {
      return {
        status: 'already_present',
        fingerprint: payload.identity.fingerprint,
        generation: payload.generation,
      };
    }

    const imported = await importPortableIdentity(payload.identity);
    await saveIdentityKeys(userId, imported);
    const installed = await loadIdentityKeys(userId);
    if (!installed || installed.fingerprint !== payload.identity.fingerprint) {
      return { status: 'invalid_vault', reason: 'POST_INSTALL_VALIDATION_FAILED' };
    }
    void runPostRestoreSync(userId, 'recovery_key');
    return {
      status: 'restored',
      fingerprint: installed.fingerprint,
      generation: payload.generation,
    };
  } catch (error) {
    return {
      status: 'invalid_vault',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
