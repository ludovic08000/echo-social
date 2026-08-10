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

interface ApiEnvelope<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

interface RegisterOptionsResponse {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  publicKey: {
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
    timeout: number;
    attestation: AttestationConveyancePreference;
    authenticatorSelection: AuthenticatorSelectionCriteria;
    excludeCredentials: Array<{
      type: 'public-key';
      id: string;
      transports?: AuthenticatorTransport[];
    }>;
  };
}

interface RecoverOptionsResponse {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  publicKey: {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: UserVerificationRequirement;
    allowCredentials: Array<{
      type: 'public-key';
      id: string;
      transports?: AuthenticatorTransport[];
    }>;
  };
}

interface RecoveryVerifyResponse {
  ok: true;
  code: 'WEBAUTHN_DEVICE_RECOVERED';
  device_id: string;
  vault: EncryptedWebDeviceVault;
  device_signing_key: string;
  device_public_key: string;
}

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

async function apiCall<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('webauthn-device', {
    body: { action, ...body },
  });

  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.clone === 'function') {
      try {
        const payload = await context.clone().json() as ApiEnvelope<T>;
        throw new Error(payload.error?.code ?? payload.error?.message ?? error.message);
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message !== 'Unexpected end of JSON input') throw parseError;
      }
    }
    throw new Error(error.message || 'WEBAUTHN_FUNCTION_FAILED');
  }

  const payload = data as ApiEnvelope<T> | null;
  if (!payload || payload.error || !payload.data) {
    throw new Error(payload?.error?.code ?? payload?.error?.message ?? 'WEBAUTHN_EMPTY_RESPONSE');
  }
  return payload.data;
}

function registrationPublicKey(options: RegisterOptionsResponse['publicKey']): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: {
      ...options.user,
      id: fromBase64Url(options.user.id),
    },
    excludeCredentials: options.excludeCredentials.map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  } as PublicKeyCredentialCreationOptions;
}

function authenticationPublicKey(options: RecoverOptionsResponse['publicKey']): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: options.allowCredentials.map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  } as PublicKeyCredentialRequestOptions;
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

function requireWebAuthn(): void {
  if (typeof window === 'undefined'
    || !window.isSecureContext
    || typeof PublicKeyCredential === 'undefined'
    || typeof navigator.credentials?.create !== 'function'
    || typeof navigator.credentials?.get !== 'function') {
    throw new Error('WEBAUTHN_NOT_SUPPORTED');
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
  const result = await apiCall<{ ok: true; registered: boolean }>('status', { deviceId });
  return result.registered === true;
}

export async function registerCurrentWindowsHelloDevice(args: {
  userId: string;
  deviceId: string;
}): Promise<void> {
  requireWebAuthn();
  if (!isWindowsWeb()) throw new Error('WEBAUTHN_WINDOWS_ONLY');
  if (!DEVICE_ID_RE.test(args.deviceId)) throw new Error('DEVICE_INVALID_ID');

  const vault = await captureEncryptedWebDeviceVault(args.userId, args.deviceId);
  const options = await apiCall<RegisterOptionsResponse>('register-options', {
    deviceId: args.deviceId,
  });
  const credential = await navigator.credentials.create({
    publicKey: registrationPublicKey(options.publicKey),
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

  await apiCall('register-verify', {
    challengeId: options.challengeId,
    deviceId: args.deviceId,
    vault,
    deviceProof: bufferToBase64(proof),
    credential: {
      id: credentialId,
      rawId: credentialId,
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      publicKey: toBase64Url(publicKey),
      publicKeyAlgorithm: algorithm,
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  });
}

export async function recoverCurrentWindowsHelloDevice(userId: string): Promise<string> {
  requireWebAuthn();
  if (!isWindowsWeb()) throw new Error('WEBAUTHN_WINDOWS_ONLY');
  const options = await apiCall<RecoverOptionsResponse>('recover-options');
  const credential = await navigator.credentials.get({
    publicKey: authenticationPublicKey(options.publicKey),
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error('WEBAUTHN_RECOVERY_CANCELLED');
  const response = credential.response as AuthenticatorAssertionResponse;
  const credentialId = toBase64Url(credential.rawId);
  const result = await apiCall<RecoveryVerifyResponse>('recover-verify', {
    challengeId: options.challengeId,
    credential: {
      id: credentialId,
      rawId: credentialId,
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
    },
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
