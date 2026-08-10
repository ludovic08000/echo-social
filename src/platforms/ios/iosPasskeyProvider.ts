/**
 * iOS Web Passkey provider (Safari/Chrome/PWA, no Capacitor dependency).
 *
 * Invariants:
 * - iOS recovery is a browser WebAuthn ceremony verified server-side by
 *   /api/webauthn-device;
 * - the Passkey is an attestation/recovery anchor, never the Aegis E2EE
 *   identity itself;
 * - recovery restores the existing DeviceID + Ed25519 + X25519 vault and never
 *   allocates a replacement DeviceID;
 * - Windows keeps its existing Windows Hello implementation untouched.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import {
  captureEncryptedWebDeviceVault,
  restoreEncryptedWebDeviceVault,
  type EncryptedWebDeviceVault,
} from '@/lib/crypto/webDeviceKeyVault';
import { setCurrentDeviceId, setCurrentDeviceUserScope } from '@/lib/messaging/currentDevice';
import { deviceApi } from '@/lib/api/deviceApi';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';
import { recordIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { recordIosPasskeyEvent } from '@/platforms/ios/iosPasskeyState';
import {
  isPlatformAuthenticatorAvailable,
  requireBrowserWebAuthn,
  webauthnFromBase64Url,
  webauthnRegistrationProofPayload,
  webauthnSha256B64Url,
  webauthnToBase64Url,
} from '@/platforms/shared/webauthnBrowser';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const API_PATH = '/api/webauthn-device';

type ApiErrorPayload = {
  code?: string;
  message?: string;
};

type ApiEnvelope<T> = {
  data: T | null;
  error: ApiErrorPayload | null;
};

type CredentialDescriptorJson = {
  type: 'public-key';
  id: string;
  transports?: AuthenticatorTransport[];
};

type RegisterOptionsResult = {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  publicKey: {
    challenge: string;
    rp: PublicKeyCredentialRpEntity;
    user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
    timeout?: number;
    attestation?: AttestationConveyancePreference;
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    excludeCredentials?: CredentialDescriptorJson[];
  };
};

type RecoverOptionsResult = {
  ok: true;
  challengeId: string;
  challenge: string;
  rpId: string;
  origin: string;
  publicKey: {
    challenge: string;
    rpId: string;
    timeout?: number;
    userVerification?: UserVerificationRequirement;
    allowCredentials?: CredentialDescriptorJson[];
  };
};

type RecoveryResult = {
  ok: true;
  code: 'WEBAUTHN_DEVICE_RECOVERED';
  device_id: string;
  vault: EncryptedWebDeviceVault;
  device_signing_key: string;
  device_public_key: string;
};

function requireIosWeb(): void {
  if (!isIosWebRuntime()) throw new Error('PASSKEY_IOS_ONLY');
}

async function apiRequest<T>(body: Record<string, unknown>): Promise<T> {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session?.access_token) throw new Error('NOT_AUTHENTICATED');

  let response: Response;
  try {
    response = await fetch(API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`WEBAUTHN_API_UNREACHABLE:${error instanceof Error ? error.message : String(error)}`);
  }

  const envelope = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || envelope?.error) {
    const code = envelope?.error?.code ?? `HTTP_${response.status}`;
    const message = envelope?.error?.message ?? response.statusText ?? 'WEBAUTHN_API_FAILED';
    throw new Error(`${code}:${message}`);
  }
  if (!envelope?.data) throw new Error('WEBAUTHN_API_EMPTY_RESPONSE');
  return envelope.data;
}

function registrationPublicKey(options: RegisterOptionsResult): PublicKeyCredentialCreationOptions {
  return {
    challenge: webauthnFromBase64Url(options.publicKey.challenge),
    rp: options.publicKey.rp,
    user: {
      ...options.publicKey.user,
      id: webauthnFromBase64Url(options.publicKey.user.id),
    },
    pubKeyCredParams: options.publicKey.pubKeyCredParams,
    timeout: options.publicKey.timeout,
    attestation: options.publicKey.attestation,
    authenticatorSelection: options.publicKey.authenticatorSelection,
    excludeCredentials: (options.publicKey.excludeCredentials ?? []).map((item) => ({
      type: 'public-key',
      id: webauthnFromBase64Url(item.id),
      transports: item.transports,
    })),
  };
}

function authenticationPublicKey(options: RecoverOptionsResult): PublicKeyCredentialRequestOptions {
  return {
    challenge: webauthnFromBase64Url(options.publicKey.challenge),
    rpId: options.publicKey.rpId,
    timeout: options.publicKey.timeout,
    userVerification: options.publicKey.userVerification,
    allowCredentials: (options.publicKey.allowCredentials ?? []).map((item) => ({
      type: 'public-key',
      id: webauthnFromBase64Url(item.id),
      transports: item.transports,
    })),
  };
}

export async function isIosPasskeySupported(): Promise<boolean> {
  if (!isIosWebRuntime()) return false;
  try {
    requireBrowserWebAuthn();
  } catch {
    return false;
  }
  return isPlatformAuthenticatorAvailable();
}

export async function getIosPasskeyStatus(deviceId: string | null): Promise<boolean> {
  if (!deviceId || !DEVICE_ID_RE.test(deviceId) || !isIosWebRuntime()) return false;
  try {
    const result = await apiRequest<{ ok: true; registered: boolean }>({
      action: 'status',
      deviceId,
    });
    const registered = result.registered === true;
    recordIosPasskeyEvent({ registered, lastError: null });
    return registered;
  } catch (error) {
    recordIosRpcError('ios.passkey.status', error);
    recordIosPasskeyEvent({ lastError: error });
    return false;
  }
}

/** Register a Passkey only for an already READY canonical device. */
export async function registerIosPasskey(args: { userId: string; deviceId: string }): Promise<void> {
  requireIosWeb();
  requireBrowserWebAuthn();
  if (!DEVICE_ID_RE.test(args.deviceId)) throw new Error('DEVICE_INVALID_ID');

  try {
    const vault = await captureEncryptedWebDeviceVault(args.userId, args.deviceId);
    const options = await apiRequest<RegisterOptionsResult>({
      action: 'register-options',
      deviceId: args.deviceId,
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

    const credentialId = webauthnToBase64Url(credential.rawId);
    const payload = webauthnRegistrationProofPayload({
      userId: args.userId,
      deviceId: args.deviceId,
      challengeId: options.challengeId,
      challenge: options.challenge,
      credentialId,
      publicKeySha256: await webauthnSha256B64Url(publicKey),
      vaultSha256: await webauthnSha256B64Url(JSON.stringify(vault)),
      rpId: options.rpId,
    });

    const identity = await loadDeviceIdentity(args.userId, args.deviceId);
    if (!identity) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
    const proof = await hardCrypto.sign('Ed25519', identity.privateKey, encodeString(payload)) as ArrayBuffer;

    await apiRequest({
      action: 'register-verify',
      challengeId: options.challengeId,
      deviceId: args.deviceId,
      credential: {
        id: credentialId,
        rawId: credentialId,
        clientDataJSON: webauthnToBase64Url(response.clientDataJSON),
        authenticatorData: webauthnToBase64Url(authenticatorData),
        publicKeyAlgorithm: algorithm,
        publicKey: webauthnToBase64Url(publicKey),
        transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
      },
      vault,
      deviceProof: bufferToBase64(proof),
    });

    recordIosPasskeyEvent({ registered: true, lastError: null });
  } catch (error) {
    recordIosRpcError('ios.passkey.register', error);
    recordIosPasskeyEvent({ lastError: error });
    throw error;
  }
}

/** Restore the exact existing iOS Web device after browser storage loss. */
export async function recoverIosDeviceWithPasskey(userId: string): Promise<string> {
  requireIosWeb();
  requireBrowserWebAuthn();

  try {
    const options = await apiRequest<RecoverOptionsResult>({ action: 'recover-options' });
    const credential = await navigator.credentials.get({
      publicKey: authenticationPublicKey(options),
    }) as PublicKeyCredential | null;
    if (!credential) throw new Error('WEBAUTHN_RECOVERY_CANCELLED');

    const response = credential.response as AuthenticatorAssertionResponse;
    const credentialId = webauthnToBase64Url(credential.rawId);

    const result = await apiRequest<RecoveryResult>({
      action: 'recover-verify',
      challengeId: options.challengeId,
      credential: {
        id: credentialId,
        rawId: credentialId,
        clientDataJSON: webauthnToBase64Url(response.clientDataJSON),
        authenticatorData: webauthnToBase64Url(response.authenticatorData),
        signature: webauthnToBase64Url(response.signature),
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
      detail: { deviceId: result.device_id, platform: 'ios-web' },
    }));
    recordIosPasskeyEvent({
      registered: true,
      lastError: null,
      lastRecoveredDeviceId: result.device_id,
    });
    return result.device_id;
  } catch (error) {
    recordIosRpcError('ios.passkey.recover', error);
    recordIosPasskeyEvent({ lastError: error });
    throw error;
  }
}

export const iosPasskeyProvider = {
  platform: 'ios' as const,
  isSupported: isIosPasskeySupported,
  getStatus: getIosPasskeyStatus,
  register: registerIosPasskey,
  recover: recoverIosDeviceWithPasskey,
};
