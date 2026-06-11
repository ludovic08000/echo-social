import { createSecureBackupVault, restoreSecureBackupVault } from './secureBackupVault';

const PASSKEY_ALIAS_PREFIX = 'forsure-passkey-vault-alias:';

export interface PasskeyVaultRegistration {
  credentialId: string;
  recoveryKey: string;
  fingerprint: string;
}

function aliasKey(userId: string) {
  return `${PASSKEY_ALIAS_PREFIX}${userId}`;
}

function requireWebAuthn() {
  if (!('PublicKeyCredential' in window) || !navigator.credentials) {
    throw new Error('WEBAUTHN_UNSUPPORTED');
  }
}

function randomChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function registerPasskeyForBackupVault(userId: string, displayName: string): Promise<PasskeyVaultRegistration> {
  requireWebAuthn();

  const vault = await createSecureBackupVault(userId);
  if (!vault) throw new Error('NO_LOCAL_IDENTITY_FOR_BACKUP');

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge() as BufferSource,
      rp: { name: 'ForSure' },
      user: {
        id: new TextEncoder().encode(userId) as BufferSource,
        name: displayName || userId,
        displayName: displayName || 'ForSure user',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 60_000,
      attestation: 'none',
    },
  }) as PublicKeyCredential | null;

  if (!credential) throw new Error('PASSKEY_CREATION_CANCELLED');

  const credentialId = toBase64Url(credential.rawId);

  // WebAuthn proves user presence/verification. In this web-only foundation,
  // the recovery key remains the actual vault unlock secret and must still be
  // saved by the user. Native passkey-secret wrapping can be added server-side later.
  localStorage.setItem(aliasKey(userId), JSON.stringify({ credentialId, createdAt: Date.now() }));

  return {
    credentialId,
    recoveryKey: vault.recoveryKey,
    fingerprint: vault.fingerprint,
  };
}

export async function verifyPasskeyBeforeVaultRestore(userId: string, recoveryKey: string) {
  requireWebAuthn();

  const raw = localStorage.getItem(aliasKey(userId));
  if (!raw) throw new Error('NO_PASSKEY_REGISTERED');
  const { credentialId } = JSON.parse(raw);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge() as BufferSource,
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) as BufferSource }],
      userVerification: 'required',
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null;

  if (!assertion) throw new Error('PASSKEY_ASSERTION_CANCELLED');

  return restoreSecureBackupVault(userId, recoveryKey);
}

export function hasLocalPasskeyVaultAlias(userId: string): boolean {
  return !!localStorage.getItem(aliasKey(userId));
}
