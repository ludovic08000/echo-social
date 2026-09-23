import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import type { PinContinuityEnvelope } from '@/lib/crypto/pinContinuityVault';
import {
  base64ToBuffer,
  bufferToBase64,
  encodeString,
} from '@/lib/crypto/utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

type JsonObject = Record<string, unknown>;

export interface ChatPinResetFailure {
  ok: false;
  code: string;
  error: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
}

export type ChatPinResetRequestResult = ChatPinResetFailure | {
  ok: true;
  challengeId: string;
  expiresAt: string;
};

export type ChatPinResetAuthorizationResult = ChatPinResetFailure | {
  ok: true;
  challengeId: string;
  authorizationToken: string;
  authorizationExpiresAt: string;
  generation: number;
};

export type ChatPinResetCommitResult = ChatPinResetFailure | {
  ok: true;
  generation: number;
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function errorContextBody(error: unknown): Promise<JsonObject | null> {
  const context = asObject(error)?.context as {
    clone?: () => { json?: () => Promise<unknown> };
    json?: () => Promise<unknown>;
  } | undefined;
  if (!context) return null;

  try {
    const readable = typeof context.clone === 'function' ? context.clone() : context;
    if (typeof readable.json !== 'function') return null;
    return asObject(await readable.json());
  } catch {
    return null;
  }
}

async function failure(
  data: unknown,
  invokeError: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): Promise<ChatPinResetFailure> {
  const direct = asObject(data);
  const payload = direct ?? await errorContextBody(invokeError);
  return {
    ok: false,
    code: typeof payload?.code === 'string' ? payload.code : fallbackCode,
    error: typeof payload?.error === 'string' ? payload.error : fallbackMessage,
    ...(typeof payload?.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: payload.retryAfterSeconds }
      : {}),
    ...(typeof payload?.attemptsRemaining === 'number'
      ? { attemptsRemaining: payload.attemptsRemaining }
      : {}),
  };
}

async function invokePinReset(body: JsonObject): Promise<{
  data: unknown;
  error: unknown;
}> {
  try {
    return await supabase.functions.invoke('verify-chat-pin', { body });
  } catch (error) {
    return { data: null, error };
  }
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function canonicalBase64Bytes(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    const decoded = base64ToBuffer(value);
    return decoded.byteLength === bytes
      && bufferToBase64(decoded).replace(/=+$/, '') === value.replace(/=+$/, '');
  } catch {
    return false;
  }
}

export function canonicalChatPinResetDeviceProof(args: {
  challengeId: string;
  userId: string;
  deviceId: string;
  issuedAtMs: number;
}): string {
  if (!UUID_RE.test(args.challengeId) || !UUID_RE.test(args.userId)) {
    throw new Error('PIN_RESET_INVALID_SCOPE');
  }
  if (!DEVICE_ID_RE.test(args.deviceId)) {
    throw new Error('PIN_RESET_INVALID_DEVICE');
  }
  if (!Number.isSafeInteger(args.issuedAtMs) || args.issuedAtMs <= 0) {
    throw new Error('PIN_RESET_INVALID_TIMESTAMP');
  }
  return [
    'forsure-aegis-pin-reset',
    args.challengeId,
    args.userId,
    args.deviceId,
    String(args.issuedAtMs),
  ].join('|');
}

export async function signChatPinResetDeviceProof(args: {
  challengeId: string;
  userId: string;
  deviceId: string;
  issuedAtMs: number;
  privateKey: CryptoKey;
}): Promise<string> {
  const payload = canonicalChatPinResetDeviceProof(args);
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    args.privateKey,
    encodeString(payload),
  ) as ArrayBuffer);
}

export async function requestChatPinReset(): Promise<ChatPinResetRequestResult> {
  const { data, error } = await invokePinReset({ action: 'request-reset' });
  const payload = asObject(data);
  if (error || payload?.ok !== true) {
    return failure(data, error, 'PIN_RESET_REQUEST_FAILED', 'Le code n’a pas pu être envoyé.');
  }

  if (
    typeof payload.challengeId !== 'string'
    || !UUID_RE.test(payload.challengeId)
    || !validIsoTimestamp(payload.expiresAt)
  ) {
    return failure(null, null, 'PIN_RESET_INVALID_RESPONSE', 'Réponse de réinitialisation invalide.');
  }

  return {
    ok: true,
    challengeId: payload.challengeId,
    expiresAt: payload.expiresAt,
  };
}

export async function authorizeChatPinReset(args: {
  userId: string;
  deviceId: string;
  challengeId: string;
  code: string;
}): Promise<ChatPinResetAuthorizationResult> {
  if (
    !UUID_RE.test(args.userId)
    || !UUID_RE.test(args.challengeId)
    || !DEVICE_ID_RE.test(args.deviceId)
    || !/^\d{6}$/.test(args.code)
  ) {
    return {
      ok: false,
      code: 'PIN_RESET_INVALID_AUTHORIZATION',
      error: 'Code ou appareil invalide.',
    };
  }

  const identity = await loadDeviceIdentity(args.userId, args.deviceId).catch(() => null);
  if (!identity) {
    return {
      ok: false,
      code: 'PIN_RESET_DEVICE_KEY_UNAVAILABLE',
      error: 'La clé privée de cet appareil Aegis est indisponible.',
    };
  }

  const issuedAtMs = Date.now();
  let signature: string;
  try {
    signature = await signChatPinResetDeviceProof({
      challengeId: args.challengeId,
      userId: args.userId,
      deviceId: args.deviceId,
      issuedAtMs,
      privateKey: identity.privateKey,
    });
  } catch {
    return {
      ok: false,
      code: 'PIN_RESET_DEVICE_PROOF_FAILED',
      error: 'La preuve de possession de l’appareil a échoué.',
    };
  }

  const { data, error } = await invokePinReset({
    action: 'authorize-reset',
    challengeId: args.challengeId,
    code: args.code,
    deviceId: args.deviceId,
    deviceProofIssuedAtMs: issuedAtMs,
    deviceProofSignature: signature,
  });
  const payload = asObject(data);
  if (error || payload?.ok !== true) {
    return failure(data, error, 'PIN_RESET_AUTHORIZATION_FAILED', 'La réinitialisation a été refusée.');
  }

  if (
    payload.challengeId !== args.challengeId
    || !canonicalBase64Bytes(payload.authorizationToken, 32)
    || !validIsoTimestamp(payload.authorizationExpiresAt)
    || typeof payload.generation !== 'number'
    || !Number.isSafeInteger(payload.generation)
    || payload.generation < 1
  ) {
    return failure(null, null, 'PIN_RESET_INVALID_RESPONSE', 'Autorisation de réinitialisation invalide.');
  }

  return {
    ok: true,
    challengeId: args.challengeId,
    authorizationToken: payload.authorizationToken,
    authorizationExpiresAt: payload.authorizationExpiresAt,
    generation: payload.generation,
  };
}

export async function commitChatPinReset(args: {
  challengeId: string;
  deviceId: string;
  authorizationToken: string;
  expectedGeneration: number;
  envelope: PinContinuityEnvelope;
}): Promise<ChatPinResetCommitResult> {
  if (
    !UUID_RE.test(args.challengeId)
    || !DEVICE_ID_RE.test(args.deviceId)
    || !canonicalBase64Bytes(args.authorizationToken, 32)
    || !Number.isSafeInteger(args.expectedGeneration)
    || args.expectedGeneration < 1
    || args.envelope.version !== 1
  ) {
    return {
      ok: false,
      code: 'PIN_RESET_INVALID_COMMIT',
      error: 'Données de remplacement du PIN invalides.',
    };
  }

  const { data, error } = await invokePinReset({
    action: 'commit-reset',
    challengeId: args.challengeId,
    authorizationToken: args.authorizationToken,
    deviceId: args.deviceId,
    expectedGeneration: args.expectedGeneration,
    version: args.envelope.version,
    ciphertext: args.envelope.ciphertext,
    iv: args.envelope.iv,
  });
  const payload = asObject(data);
  if (error || payload?.ok !== true) {
    return failure(data, error, 'PIN_RESET_COMMIT_FAILED', 'Le nouveau PIN n’a pas été enregistré.');
  }

  if (
    typeof payload.generation !== 'number'
    || !Number.isSafeInteger(payload.generation)
    || payload.generation !== args.expectedGeneration + 1
  ) {
    return failure(null, null, 'PIN_RESET_INVALID_RESPONSE', 'Confirmation de réinitialisation invalide.');
  }

  return { ok: true, generation: payload.generation };
}
