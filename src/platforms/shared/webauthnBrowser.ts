/**
 * Primitives WebAuthn navigateur partagées par les providers plateforme.
 *
 * Invariant : ce module ne contient AUCUNE cryptographie d'identité E2EE.
 * Il ne fait que formater les options WebAuthn et valider localement une
 * assertion (origin, rpIdHash, flags UV/UP). Le chemin Windows existant
 * (`src/lib/crypto/windowsHelloDeviceRecovery.ts`) n'est pas modifié.
 */
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';

export interface WebAuthnRpContext {
  origin: string;
  rpId: string;
}

export interface CredentialDescriptorJson {
  id: string;
  transports?: AuthenticatorTransport[];
}

export interface WebAuthnRegistrationBegin {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  userId: string;
  email: string;
  excludeCredentials: CredentialDescriptorJson[];
}

export interface WebAuthnRecoveryBegin {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  allowCredentials: Array<CredentialDescriptorJson & { deviceId: string }>;
}

export function webauthnToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return hardGlobals.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function webauthnFromBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('WEBAUTHN_BASE64URL_INVALID');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = hardGlobals.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export async function webauthnSha256B64Url(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string'
    ? new hardGlobals.TextEncoder().encode(value)
    : value instanceof Uint8Array ? value : new Uint8Array(value);
  return webauthnToBase64Url(await hardCrypto.digest('SHA-256', bytes));
}

export function requireBrowserWebAuthn(): void {
  if (typeof window === 'undefined'
    || !window.isSecureContext
    || typeof PublicKeyCredential === 'undefined'
    || typeof navigator.credentials?.create !== 'function'
    || typeof navigator.credentials?.get !== 'function') {
    throw new Error('WEBAUTHN_NOT_SUPPORTED');
  }
}

export function currentWebAuthnRpContext(): WebAuthnRpContext {
  if (typeof window === 'undefined') throw new Error('WEBAUTHN_WINDOW_REQUIRED');
  return { origin: window.location.origin, rpId: window.location.hostname.toLowerCase() };
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function buildRegistrationPublicKey(
  options: WebAuthnRegistrationBegin,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: webauthnFromBase64Url(options.challenge),
    rp: { id: options.rpId, name: 'ForSure' },
    user: {
      id: new hardGlobals.TextEncoder().encode(options.userId),
      name: options.email || options.userId,
      displayName: options.email || 'ForSure user',
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60_000,
    attestation: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'required',
    },
    excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
      type: 'public-key',
      id: webauthnFromBase64Url(credential.id),
      transports: credential.transports,
    })),
  };
}

export function buildAuthenticationPublicKey(
  options: WebAuthnRecoveryBegin,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: webauthnFromBase64Url(options.challenge),
    rpId: options.rpId,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      type: 'public-key',
      id: webauthnFromBase64Url(credential.id),
      transports: credential.transports,
    })),
  };
}

export function signCountFromAuthenticatorData(authenticatorData: ArrayBuffer): number {
  if (authenticatorData.byteLength < 37) throw new Error('WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  return new DataView(authenticatorData).getUint32(33, false);
}

/** Vérification locale fail-closed d'une assertion (origin + rpIdHash + UV/UP). */
export async function validateWebAuthnAssertion(
  response: AuthenticatorAssertionResponse,
  options: WebAuthnRecoveryBegin,
): Promise<void> {
  let clientData: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try {
    clientData = JSON.parse(new hardGlobals.TextDecoder().decode(response.clientDataJSON));
  } catch {
    throw new Error('WEBAUTHN_CLIENT_DATA_INVALID');
  }
  if (clientData.type !== 'webauthn.get') throw new Error('WEBAUTHN_CLIENT_TYPE_MISMATCH');
  if (clientData.challenge !== options.challenge) throw new Error('WEBAUTHN_CHALLENGE_MISMATCH');
  if (clientData.origin !== options.origin) throw new Error('WEBAUTHN_ORIGIN_MISMATCH');
  if (clientData.crossOrigin === true) throw new Error('WEBAUTHN_CROSS_ORIGIN_DENIED');

  const auth = new Uint8Array(response.authenticatorData);
  if (auth.length < 37) throw new Error('WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  const expectedRpHash = new Uint8Array(await hardCrypto.digest(
    'SHA-256',
    new hardGlobals.TextEncoder().encode(options.rpId),
  ));
  for (let index = 0; index < 32; index += 1) {
    if (auth[index] !== expectedRpHash[index]) throw new Error('WEBAUTHN_RP_ID_HASH_MISMATCH');
  }
  const flags = auth[32];
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
    throw new Error('WEBAUTHN_USER_VERIFICATION_REQUIRED');
  }
}

export function webauthnRegistrationProofPayload(args: {
  userId: string;
  deviceId: string;
  challengeId: string;
  challenge: string;
  credentialId: string;
  publicKeySha256: string;
  vaultSha256: string;
  rpId: string;
}): string {
  return JSON.stringify({
    protocol: 'forsure-webauthn-device-registration',
    version: 1,
    userId: args.userId,
    deviceId: args.deviceId,
    challengeId: args.challengeId,
    challenge: args.challenge,
    credentialId: args.credentialId,
    publicKeySha256: args.publicKeySha256,
    vaultSha256: args.vaultSha256,
    rpId: args.rpId,
  });
}
