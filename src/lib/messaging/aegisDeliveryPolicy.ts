// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Inspired by Signal Desktop's ts/textsecure/Errors.std.ts and adapted for the
// Aegis browser transport. Signal's libsignal, Electron and HTTPError classes
// are deliberately not copied; this module classifies unknown web errors into
// stable, user-safe recovery decisions.

import { computeAegisRetryDelay } from './signalBackoff';
import { parseRetryAfter } from './signalRetryAfter';

export type AegisDeliveryFailureKind =
  | 'identity-changed'
  | 'device-mismatch'
  | 'unregistered-recipient'
  | 'unauthorized'
  | 'challenge-required'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'invalid-payload'
  | 'unknown';

export type AegisRetryMode = 'automatic' | 'manual' | 'after-user-action' | 'never';

export type AegisDeliveryFailure = Readonly<{
  kind: AegisDeliveryFailureKind;
  retryMode: AegisRetryMode;
  title: string;
  userMessage: string;
  technicalMessage?: string;
  httpStatus?: number;
  retryAt?: number;
  shouldRefreshDevices?: boolean;
  shouldResetSession?: boolean;
}>;

type ErrorSnapshot = {
  name: string;
  message: string;
  status?: number;
  retryAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function readFiniteNumber(record: Record<string, unknown> | null, keys: ReadonlyArray<string>): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(record: Record<string, unknown> | null, keys: ReadonlyArray<string>): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function snapshotError(error: unknown, now: number): ErrorSnapshot {
  if (error instanceof Error) {
    const record = asRecord(error);
    const status = readFiniteNumber(record, ['status', 'statusCode', 'code']);
    const retryAt = extractRetryAt(record, now);
    return { name: error.name || 'Error', message: error.message || error.name, status, retryAt };
  }

  const record = asRecord(error);
  if (record) {
    const name = readString(record, ['name', 'type']) ?? 'Error';
    const message = readString(record, ['message', 'error', 'detail']) ?? name;
    const status = readFiniteNumber(record, ['status', 'statusCode', 'code']);
    const retryAt = extractRetryAt(record, now);
    return { name, message, status, retryAt };
  }

  return {
    name: typeof error === 'string' ? 'Error' : 'UnknownError',
    message: typeof error === 'string' ? error : 'Erreur inconnue',
  };
}

function extractRetryAt(record: Record<string, unknown> | null, now: number): number | undefined {
  if (!record) return undefined;

  const retryAt = readFiniteNumber(record, ['retryAt']);
  if (retryAt !== undefined) return retryAt > 10_000_000_000 ? retryAt : now + retryAt;

  const retryAfterMs = readFiniteNumber(record, ['retryAfterMs']);
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return now + retryAfterMs;

  const retryAfterSeconds = readFiniteNumber(record, ['retryAfterSecs', 'retryAfterSeconds']);
  if (retryAfterSeconds !== undefined && retryAfterSeconds >= 0) return now + retryAfterSeconds * 1_000;

  const header = readString(record, ['retry-after', 'retryAfter']);
  const parsed = parseRetryAfter(header, now);
  return parsed === undefined ? undefined : now + parsed;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’]/g, "'")
    .trim();
}

function containsAny(value: string, needles: ReadonlyArray<string>): boolean {
  return needles.some(needle => value.includes(needle));
}

function result(
  snapshot: ErrorSnapshot,
  values: Omit<AegisDeliveryFailure, 'technicalMessage' | 'httpStatus' | 'retryAt'>,
): AegisDeliveryFailure {
  return {
    ...values,
    technicalMessage: snapshot.message,
    httpStatus: snapshot.status,
    retryAt: snapshot.retryAt,
  };
}

/** Converts transport/crypto errors into stable recovery behavior and safe UI text. */
export function classifyAegisDeliveryFailure(
  error: unknown,
  now: number = Date.now(),
): AegisDeliveryFailure {
  const snapshot = snapshotError(error, now);
  const name = normalize(snapshot.name);
  const message = normalize(snapshot.message);
  const combined = `${name} ${message}`;
  const status = snapshot.status;

  if (
    containsAny(combined, [
      'outgoingidentitykeyerror',
      'untrustedidentity',
      'identity key changed',
      'security key changed',
      'safety number changed',
      'cle de securite du contact modifiee',
      'fingerprint changed',
    ])
  ) {
    return result(snapshot, {
      kind: 'identity-changed',
      retryMode: 'after-user-action',
      title: 'Clé de sécurité modifiée',
      userMessage: "Vérifiez l’identité du contact avant de renvoyer ce message.",
      shouldResetSession: false,
    });
  }

  if (containsAny(combined, ['mismatcheddeviceserror', 'mismatched devices', 'stale devices', 'missing devices'])) {
    return result(snapshot, {
      kind: 'device-mismatch',
      retryMode: 'automatic',
      title: 'Appareils à resynchroniser',
      userMessage: 'Aegis doit actualiser les appareils du contact avant de réessayer.',
      shouldRefreshDevices: true,
    });
  }

  if (containsAny(combined, ['unregisteredusererror', 'unregistered recipient', 'recipient is not registered'])) {
    return result(snapshot, {
      kind: 'unregistered-recipient',
      retryMode: 'never',
      title: 'Contact indisponible',
      userMessage: 'Ce contact ne peut plus recevoir de messages sécurisés.',
    });
  }

  if (
    status === 401 || status === 403 ||
    containsAny(combined, ['unauthorizedmessagesenderror', 'requestunauthorized', 'unauthorized message send'])
  ) {
    return result(snapshot, {
      kind: 'unauthorized',
      retryMode: 'after-user-action',
      title: 'Session expirée',
      userMessage: 'Reconnectez votre compte avant de renvoyer le message.',
      shouldResetSession: true,
    });
  }

  if (status === 428 || containsAny(combined, ['sendmessagechallengeerror', 'challenge required'])) {
    return result(snapshot, {
      kind: 'challenge-required',
      retryMode: 'after-user-action',
      title: 'Vérification requise',
      userMessage: 'Une vérification de sécurité est nécessaire avant le nouvel envoi.',
    });
  }

  if (status === 429 || containsAny(combined, ['rate limit', 'too many requests', 'operation limitee'])) {
    return result(snapshot, {
      kind: 'rate-limited',
      retryMode: 'automatic',
      title: 'Envoi temporairement limité',
      userMessage: 'Aegis réessaiera après le délai imposé par le serveur.',
    });
  }

  if (
    status === -1 ||
    containsAny(combined, [
      'sendmessagenetworkerror',
      'connecttimeouterror',
      'networkerror',
      'failed to fetch',
      'network request failed',
      'load failed',
      'timeout',
      'offline',
    ])
  ) {
    return result(snapshot, {
      kind: 'network',
      retryMode: 'automatic',
      title: 'Connexion indisponible',
      userMessage: 'Le message restera en attente et sera renvoyé automatiquement.',
    });
  }

  if (status !== undefined && status >= 500 && status <= 599) {
    return result(snapshot, {
      kind: 'server',
      retryMode: 'automatic',
      title: 'Service temporairement indisponible',
      userMessage: 'Le serveur a refusé temporairement l’envoi. Aegis réessaiera.',
    });
  }

  if (
    status === 400 || status === 413 || status === 415 || status === 422 ||
    containsAny(combined, ['invalid payload', 'malformed message', 'message too large', 'unsupported media'])
  ) {
    return result(snapshot, {
      kind: 'invalid-payload',
      retryMode: 'never',
      title: 'Message non envoyable',
      userMessage: 'Modifiez le contenu ou la pièce jointe avant de réessayer.',
    });
  }

  return result(snapshot, {
    kind: 'unknown',
    retryMode: 'manual',
    title: "Échec d’envoi",
    userMessage: 'La cause est inconnue. Une nouvelle tentative manuelle est possible.',
  });
}

export function shouldOfferAegisRetry(failure: AegisDeliveryFailure): boolean {
  return failure.retryMode === 'automatic' || failure.retryMode === 'manual';
}

export function computeRetryDelayForFailure(
  failure: AegisDeliveryFailure,
  attempt: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): number | null {
  if (failure.retryMode !== 'automatic') return null;
  const retryAfterMs = failure.retryAt === undefined ? undefined : Math.max(0, failure.retryAt - now);
  return computeAegisRetryDelay({ attempt, retryAfterMs, random });
}
