/**
 * Provider Passkey iOS (WebAuthn Safari/Chrome iOS, sans Capacitor).
 *
 * Invariants :
 * - ce module ne s'exécute QUE sur un runtime iOS ; Windows conserve
 *   strictement son chemin `windowsHelloDeviceRecovery` inchangé ;
 * - il ne crée, ne remplace et ne fait jamais tourner l'identité E2EE :
 *   la passkey scelle uniquement le coffre de récupération du device déjà
 *   enrôlé et approuvé côté serveur ;
 * - il réutilise les tables/RPC WebAuthn existantes, sans nouveau schéma.
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
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';
import { recordIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { recordIosPasskeyEvent } from '@/platforms/ios/iosPasskeyState';
import {
  buildAuthenticationPublicKey,
  buildRegistrationPublicKey,
  currentWebAuthnRpContext,
  isPlatformAuthenticatorAvailable,
  requireBrowserWebAuthn,
  signCountFromAuthenticatorData,
  validateWebAuthnAssertion,
  webauthnRegistrationProofPayload,
  webauthnSha256B64Url,
  webauthnToBase64Url,
  type WebAuthnRecoveryBegin,
  type WebAuthnRegistrationBegin,
} from '@/platforms/shared/webauthnBrowser';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

type RecoveryResult = {
  ok: true;
  device_id: string;
  vault: EncryptedWebDeviceVault;
  device_signing_key: string;
  device_public_key: string;
};

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw new Error(`${name}:${error.message}`);
  if (!data) throw new Error(`${name}:EMPTY_RESPONSE`);
  return data as T;
}

function requireIos(): void {
  if (!isIosRuntime()) throw new Error('PASSKEY_IOS_ONLY');
}

export async function isIosPasskeySupported(): Promise<boolean> {
  if (!isIosRuntime()) return false;
  try {
    requireBrowserWebAuthn();
  } catch {
    return false;
  }
  return isPlatformAuthenticatorAvailable();
}

/** Le device iOS courant possède-t-il déjà une passkey enregistrée ? */
export async function getIosPasskeyStatus(deviceId: string | null): Promise<boolean> {
  if (!deviceId || !DEVICE_ID_RE.test(deviceId) || !isIosRuntime()) return false;
  try {
    const { rpId } = currentWebAuthnRpContext();
    const result = await rpc<{ ok: true; registered: boolean }>('webauthn_device_status', {
      p_device_id: deviceId,
      p_rp_id: rpId,
    });
    const registered = result.registered === true;
    recordIosPasskeyEvent({ registered });
    return registered;
  } catch (error) {
    recordIosRpcError('ios.passkey.status', error);
    recordIosPasskeyEvent({ lastError: error });
    return false;
  }
}

/**
 * Enregistre une passkey iOS pour l'appareil courant.
 * Prérequis serveur : device approved + bound (contrôlé par la RPC).
 */
export async function registerIosPasskey(args: { userId: string; deviceId: string }): Promise<void> {
  requireIos();
  requireBrowserWebAuthn();
  if (!DEVICE_ID_RE.test(args.deviceId)) throw new Error('DEVICE_INVALID_ID');

  try {
    const { origin, rpId } = currentWebAuthnRpContext();
    const vault = await captureEncryptedWebDeviceVault(args.userId, args.deviceId);
    const options = await rpc<WebAuthnRegistrationBegin>('webauthn_begin_device_registration', {
      p_device_id: args.deviceId,
      p_origin: origin,
      p_rp_id: rpId,
    });

    const credential = await navigator.credentials.create({
      publicKey: buildRegistrationPublicKey(options),
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

    await rpc('webauthn_finalize_device_registration_rpc', {
      p_device_id: args.deviceId,
      p_challenge_id: options.challengeId,
      p_credential_id: credentialId,
      p_rp_id: options.rpId,
      p_public_key_spki: webauthnToBase64Url(publicKey),
      p_algorithm: algorithm,
      p_sign_count: signCountFromAuthenticatorData(authenticatorData),
      p_transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
      p_vault_version: vault.version,
      p_vault_iv: vault.iv,
      p_vault_ciphertext: vault.ciphertext,
      p_device_proof_b64: bufferToBase64(proof),
      p_proof_payload: payload,
    });

    recordIosPasskeyEvent({ registered: true, lastError: null });
  } catch (error) {
    recordIosRpcError('ios.passkey.register', error);
    recordIosPasskeyEvent({ lastError: error });
    throw error;
  }
}

/**
 * Récupère le device iOS courant via passkey après purge du stockage web.
 * Aucune nouvelle identité n'est générée : le coffre restaure les clés
 * existantes du DeviceID déjà connu du serveur.
 */
export async function recoverIosDeviceWithPasskey(userId: string): Promise<string> {
  requireIos();
  requireBrowserWebAuthn();

  try {
    const { origin, rpId } = currentWebAuthnRpContext();
    const options = await rpc<WebAuthnRecoveryBegin>('webauthn_begin_device_recovery', {
      p_origin: origin,
      p_rp_id: rpId,
    });

    const credential = await navigator.credentials.get({
      publicKey: buildAuthenticationPublicKey(options),
    }) as PublicKeyCredential | null;
    if (!credential) throw new Error('WEBAUTHN_RECOVERY_CANCELLED');

    const response = credential.response as AuthenticatorAssertionResponse;
    await validateWebAuthnAssertion(response, options);
    const credentialId = webauthnToBase64Url(credential.rawId);
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
    // Le lifecycle canonique reprend la main : SPK/OPK uniquement après binding.
    await deviceApi.prepareKeys(userId);
    window.dispatchEvent(new CustomEvent('forsure:webauthn-device-restored', {
      detail: { deviceId: result.device_id },
    }));
    recordIosPasskeyEvent({ registered: true, lastError: null, lastRecoveredDeviceId: result.device_id });
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
