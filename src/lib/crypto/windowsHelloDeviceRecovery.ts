import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import {
  captureEncryptedWebDeviceVault,
  restoreEncryptedWebDeviceVault,
  type EncryptedWebDeviceVault,
} from '@/lib/crypto/webDeviceKeyVault';
import {
  setCurrentDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';
import { deviceApi } from '@/lib/api/deviceApi';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

type CredentialDescriptorJson = {
  id: string;
  transports?: AuthenticatorTransport[];
};

type RegistrationBegin = {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  userId: string;
  email: string;
  excludeCredentials: CredentialDescriptorJson[];
};

type RecoveryBegin = {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  allowCredentials: Array<CredentialDescriptorJson & { deviceId: string }>;
};

type RecoveryResult = {
  ok: true;
  code: 'WEBAUTHN_DEVICE_RECOVERED';
  device_id: string;
  vault: EncryptedWebDeviceVault;
  device_signing_key: string;
  device_public_key: string;
};

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return hardGlobals.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('WEBAUTHN_BASE64URL_INVALID');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = hardGlobals.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function sha256B64Url(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string'
    ? new hardGlobals.TextEncoder().encode(value)
    : value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = await hardCrypto.digest('SHA-256', bytes);
  return toBase64Url(digest);
}

function requireWebAuthn(): void {
  if (typeof window === 'undefined'
    || !window.isSecureContext
    || typeof PublicKeyCredential === 'undefined'
    || typeof navigator.credentials?.create !== 'function'
    || typeof navigator.credentials?.get !== 'function') {
    throw new Error('WEBAUTHN_NOT_SUPPORTED');
  }
}

function currentRpContext(): { origin: string; rpId: string } {
  if (typeof window === 'undefined') throw new Error('WEBAUTHN_WINDOW_REQUIRED');
  return { origin: window.location.origin, rpId: window.location.hostname.toLowerCase() };
}

function rpcError(prefix: string, error: { message?: string; code?: string } | null): never {
  throw new Error(`${prefix}:${error?.message ?? error?.code ?? 'UNKNOWN'}`);
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) rpcError(name, error);
  if (!data) throw new Error(`${name}:EMPTY_RESPONSE`);
  return data as T;
}

function registrationPublicKey(options: RegistrationBegin): PublicKeyCredentialCreationOptions {
  const userId = new hardGlobals.TextEncoder().encode(options.userId);
  return {
    challenge: fromBase64Url(options.challenge),
    rp: { id: options.rpId, name: 'ForSure' },
    user: {
      id: userId,
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
      id: fromBase64Url(credential.id),
      transports: credential.transports,
    })),
  };
}

function authenticationPublicKey(options: RecoveryBegin): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromBase64Url(options.challenge),
    rpId: options.rpId,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      type: 'public-key',
      id: fromBase64Url(credential.id),
      transports: credential.transports,
    })),
  };
}

function registrationProofPayload(args: {
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

function signCountFromAuthenticatorData(authenticatorData: ArrayBuffer): number {
  if (authenticatorData.byteLength < 37) throw new Error('WEBAUTHN_AUTHENTICATOR_DATA_INVALID');
  return new DataView(authenticatorData).getUint32(33, false);
}

async function validateLocalAssertion(
  response: AuthenticatorAssertionResponse,
  options: RecoveryBegin,
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

export function isWindowsWeb(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');
}

export async function isWindowsHelloAvailable(): Promise<boolean> {
  if (!isWindowsWeb() || typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function getWindowsHelloRecoveryStatus(deviceId: string): Promise<boolean> {
  if (!DEVICE_ID_RE.test(deviceId) || !isWindowsWeb()) return false;
  const { rpId } = currentRpContext();
  const result = await rpc<{ ok: true; registered: boolean }>('webauthn_device_status', {
    p_device_id: deviceId,
    p_rp_id: rpId,
  });
  return result.registered === true;
}

export async function registerCurrentWindowsHelloDevice(args: {
  userId: string;
  deviceId: string;
}): Promise<void> {
  requireWebAuthn();
  if (!isWindowsWeb()) throw new Error('WEBAUTHN_WINDOWS_ONLY');
  if (!DEVICE_ID_RE.test(args.deviceId)) throw new Error('DEVICE_INVALID_ID');

  const { origin, rpId } = currentRpContext();
  const vault = await captureEncryptedWebDeviceVault(args.userId, args.deviceId);
  const options = await rpc<RegistrationBegin>('webauthn_begin_device_registration', {
    p_device_id: args.deviceId,
    p_origin: origin,
    p_rp_id: rpId,
  });

  const credential = await navigator.credentials.create({
    publicKey: registrationPublicKey(options),
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error('WEBAUTHN_REGISTRATION_CANCELLED');

  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getPublicKey !== 'function'
    || typeof response.getAuthenticatorData !== 'function'
    || typeof response.getPublicKeyAlgorithm !== 'function') {
    throw new Error('WEBAUTHN_BROWSER_TOO_OLD');
  }

  const publicKey = response.getPublicKey();
  const authenticatorData = response.getAuthenticatorData();
  if (!publicKey || !authenticatorData) throw new Error('WEBAUTHN_PUBLIC_KEY_UNAVAILABLE');
  const algorithm = response.getPublicKeyAlgorithm();
  if (algorithm !== -7) throw new Error('WEBAUTHN_ALGORITHM_UNSUPPORTED');

  const credentialId = toBase64Url(credential.rawId);
  const publicKeySha256 = await sha256B64Url(publicKey);
  const vaultSha256 = await sha256B64Url(JSON.stringify(vault));
  const payload = registrationProofPayload({
    userId: args.userId,
    deviceId: args.deviceId,
    challengeId: options.challengeId,
    challenge: options.challenge,
    credentialId,
    publicKeySha256,
    vaultSha256,
    rpId: options.rpId,
  });

  const deviceIdentity = await loadDeviceIdentity(args.userId, args.deviceId);
  if (!deviceIdentity) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
  const proof = await hardCrypto.sign(
    'Ed25519',
    deviceIdentity.privateKey,
    encodeString(payload),
  ) as ArrayBuffer;

  await rpc('webauthn_finalize_device_registration_rpc', {
    p_device_id: args.deviceId,
    p_challenge_id: options.challengeId,
    p_credential_id: credentialId,
    p_rp_id: options.rpId,
    p_public_key_spki: toBase64Url(publicKey),
    p_algorithm: algorithm,
    p_sign_count: signCountFromAuthenticatorData(authenticatorData),
    p_transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    p_vault_version: vault.version,
    p_vault_iv: vault.iv,
    p_vault_ciphertext: vault.ciphertext,
    p_device_proof_b64: bufferToBase64(proof),
    p_proof_payload: payload,
  });
}

export async function recoverCurrentWindowsHelloDevice(userId: string): Promise<string> {
  requireWebAuthn();
  if (!isWindowsWeb()) throw new Error('WEBAUTHN_WINDOWS_ONLY');

  const { origin, rpId } = currentRpContext();
  const options = await rpc<RecoveryBegin>('webauthn_begin_device_recovery', {
    p_origin: origin,
    p_rp_id: rpId,
  });

  const credential = await navigator.credentials.get({
    publicKey: authenticationPublicKey(options),
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error('WEBAUTHN_RECOVERY_CANCELLED');

  const response = credential.response as AuthenticatorAssertionResponse;
  await validateLocalAssertion(response, options);
  const credentialId = toBase64Url(credential.rawId);
  if (!(options.allowCredentials ?? []).some((item) => item.id === credentialId)) {
    throw new Error('WEBAUTHN_CREDENTIAL_NOT_ALLOWED');
  }

  const result = await rpc<RecoveryResult>('webauthn_recover_device_vault_rpc', {
    p_challenge_id: options.challengeId,
    p_credential_id: credentialId,
  });
  if (!DEVICE_ID_RE.test(result.device_id)) throw new Error('WEBAUTHN_RECOVERED_DEVICE_INVALID');

  await restoreEncryptedWebDeviceVault({
    userId,
    deviceId: result.device_id,
    vault: result.vault,
    expectedDeviceSigningKey: result.device_signing_key,
    expectedDevicePublicKey: result.device_public_key,
  });

  setCurrentDeviceUserScope(userId);
  setCurrentDeviceId(result.device_id);
  await deviceApi.prepareKeys(userId);
  window.dispatchEvent(new CustomEvent('forsure:webauthn-device-restored', {
    detail: { deviceId: result.device_id },
  }));
  return result.device_id;
}
