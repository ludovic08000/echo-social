/**
 * Aegis PIN continuity vault.
 *
 * The server stores only an AES-GCM envelope sealed by the account's random,
 * non-exportable Master Key. The six-digit PIN and its local verifier are never
 * exposed as server-readable material.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { getSessionMasterKey } from './accountKeyBackup';

export const PIN_CONTINUITY_VERSION = 1 as const;
const LOCAL_PIN_VERSION = 3 as const;
const ENVELOPE_IV_BYTES = 12;
const LOCAL_SALT_BYTES = 32;
const LOCAL_IV_BYTES = 12;
const MIN_WRAPPED_BLOB_BYTES = 32;
const MAX_WRAPPED_BLOB_BYTES = 512;
const MIN_CIPHERTEXT_BYTES = 48;
const MAX_CIPHERTEXT_BYTES = 6_144;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export interface PinContinuityEnvelope {
  version: typeof PIN_CONTINUITY_VERSION;
  ciphertext: string;
  iv: string;
}

export interface PortablePinRecord {
  id: string;
  version: typeof LOCAL_PIN_VERSION;
  salt: string;
  iv: string;
  wrappedBlob: string;
  createdAt: number;
}

export type PinContinuityEnsureStatus =
  | 'matched'
  | 'published'
  | 'locked'
  | 'unavailable'
  | 'invalid'
  | 'mismatch'
  | 'write_failed'
  | 'readback_failed';

type RemotePinContinuity =
  | PinContinuityEnvelope
  | null
  | 'unavailable'
  | 'invalid';

const ensureJobs = new Map<string, Promise<PinContinuityEnsureStatus>>();

export function pinContinuityAad(userId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(
    `FORSURE-PIN-CONTINUITY-v1|${userId}`,
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return hardGlobals.btoa(binary);
}

function decodeCanonicalBase64(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): Uint8Array | null {
  if (
    typeof value !== 'string'
    || value.length < 4
    || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }

  try {
    const binary = hardGlobals.atob(value);
    if (binary.length < minBytes || binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const canonical = toBase64(bytes).replace(/=+$/, '');
    if (canonical !== value.replace(/=+$/, '')) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function validatePortablePinRecord(
  candidate: unknown,
  userId: string,
): PortablePinRecord | null {
  if (
    !candidate
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || typeof userId !== 'string'
    || userId.length < 1
    || userId.length > 128
  ) {
    return null;
  }

  const record = candidate as Partial<PortablePinRecord>;
  if (record.id !== userId || record.version !== LOCAL_PIN_VERSION) return null;
  if (!decodeCanonicalBase64(record.salt, LOCAL_SALT_BYTES, LOCAL_SALT_BYTES)) return null;
  if (!decodeCanonicalBase64(record.iv, LOCAL_IV_BYTES, LOCAL_IV_BYTES)) return null;
  if (!decodeCanonicalBase64(
    record.wrappedBlob,
    MIN_WRAPPED_BLOB_BYTES,
    MAX_WRAPPED_BLOB_BYTES,
  )) return null;
  if (
    typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt <= 0
    || record.createdAt > Date.now() + MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }

  return {
    id: record.id,
    version: LOCAL_PIN_VERSION,
    salt: record.salt,
    iv: record.iv,
    wrappedBlob: record.wrappedBlob,
    createdAt: record.createdAt,
  };
}

export function equalPortablePinRecords(
  left: PortablePinRecord,
  right: PortablePinRecord,
): boolean {
  return left.id === right.id
    && left.version === right.version
    && left.salt === right.salt
    && left.iv === right.iv
    && left.wrappedBlob === right.wrappedBlob
    && left.createdAt === right.createdAt;
}

function validateEnvelope(candidate: unknown): PinContinuityEnvelope | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const envelope = candidate as Partial<PinContinuityEnvelope>;
  if (envelope.version !== PIN_CONTINUITY_VERSION) return null;
  if (!decodeCanonicalBase64(
    envelope.iv,
    ENVELOPE_IV_BYTES,
    ENVELOPE_IV_BYTES,
  )) return null;
  if (!decodeCanonicalBase64(
    envelope.ciphertext,
    MIN_CIPHERTEXT_BYTES,
    MAX_CIPHERTEXT_BYTES,
  )) return null;

  return {
    version: PIN_CONTINUITY_VERSION,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
  };
}

export async function sealPinContinuityRecord(
  record: PortablePinRecord,
  userId: string,
  masterKey: CryptoKey,
): Promise<PinContinuityEnvelope> {
  const validated = validatePortablePinRecord(record, userId);
  if (!validated) throw new Error('AEGIS_PIN_CONTINUITY_INVALID_LOCAL_RECORD');

  const iv = hardCrypto.getRandomValues(new Uint8Array(ENVELOPE_IV_BYTES));
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: pinContinuityAad(userId).slice().buffer,
      tagLength: 128,
    },
    masterKey,
    new hardGlobals.TextEncoder().encode(
      hardGlobals.jsonStringify(validated),
    ),
  );

  return {
    version: PIN_CONTINUITY_VERSION,
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
  };
}

export async function openPinContinuityRecord(
  candidate: PinContinuityEnvelope,
  userId: string,
  masterKey: CryptoKey,
): Promise<PortablePinRecord | null> {
  const envelope = validateEnvelope(candidate);
  if (!envelope) return null;

  const iv = decodeCanonicalBase64(
    envelope.iv,
    ENVELOPE_IV_BYTES,
    ENVELOPE_IV_BYTES,
  );
  const ciphertext = decodeCanonicalBase64(
    envelope.ciphertext,
    MIN_CIPHERTEXT_BYTES,
    MAX_CIPHERTEXT_BYTES,
  );
  if (!iv || !ciphertext) return null;

  try {
    const plaintext = await hardCrypto.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as Uint8Array<ArrayBuffer>,
        additionalData: pinContinuityAad(userId).slice().buffer,
        tagLength: 128,
      },
      masterKey,
      ciphertext as Uint8Array<ArrayBuffer>,
    );
    const decoded = hardGlobals.jsonParse(
      new hardGlobals.TextDecoder().decode(plaintext),
    );
    return validatePortablePinRecord(decoded, userId);
  } catch {
    return null;
  }
}

type RpcClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

function rpcClient(): RpcClient {
  return supabase as unknown as RpcClient;
}

export async function hasRemotePinContinuity(): Promise<boolean | 'unavailable'> {
  try {
    const { data, error } = await rpcClient().rpc('aegis_pin_continuity_has');
    if (error) return 'unavailable';
    return data === true;
  } catch {
    return 'unavailable';
  }
}

export async function fetchRemotePinContinuity(): Promise<RemotePinContinuity> {
  try {
    const { data, error } = await rpcClient().rpc('aegis_pin_continuity_get');
    if (error) return 'unavailable';
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return validateEnvelope(row) ?? 'invalid';
  } catch {
    return 'unavailable';
  }
}

async function upsertRemotePinContinuity(
  envelope: PinContinuityEnvelope,
): Promise<boolean> {
  const validated = validateEnvelope(envelope);
  if (!validated) return false;

  try {
    const { data, error } = await rpcClient().rpc(
      'aegis_pin_continuity_upsert',
      {
        p_version: validated.version,
        p_ciphertext: validated.ciphertext,
        p_iv: validated.iv,
      },
    );
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function deleteRemotePinContinuity(): Promise<boolean> {
  try {
    const { data, error } = await rpcClient().rpc(
      'aegis_pin_continuity_delete',
    );
    return !error && data === true;
  } catch {
    return false;
  }
}

async function ensurePinContinuityOnce(
  userId: string,
  record: PortablePinRecord,
): Promise<PinContinuityEnsureStatus> {
  const validated = validatePortablePinRecord(record, userId);
  if (!validated) return 'invalid';

  const masterKey = getSessionMasterKey();
  if (!masterKey) return 'locked';

  const current = await fetchRemotePinContinuity();
  if (current === 'unavailable') return 'unavailable';
  if (current === 'invalid') return 'invalid';

  if (current) {
    const remoteRecord = await openPinContinuityRecord(
      current,
      userId,
      masterKey,
    );
    if (!remoteRecord) return 'invalid';
    return equalPortablePinRecords(validated, remoteRecord)
      ? 'matched'
      : 'mismatch';
  }

  const envelope = await sealPinContinuityRecord(
    validated,
    userId,
    masterKey,
  );
  if (!(await upsertRemotePinContinuity(envelope))) return 'write_failed';

  const stored = await fetchRemotePinContinuity();
  if (!stored || stored === 'unavailable') return 'readback_failed';
  if (stored === 'invalid') return 'invalid';

  const reopened = await openPinContinuityRecord(stored, userId, masterKey);
  if (!reopened) return 'readback_failed';
  if (!equalPortablePinRecords(validated, reopened)) return 'mismatch';
  return 'published';
}

/**
 * Idempotently verifies or creates the user's Master-Key-sealed PIN envelope.
 * Concurrent gates sharing the same local record reuse one operation.
 */
export function ensurePinContinuity(
  userId: string,
  record: PortablePinRecord,
): Promise<PinContinuityEnsureStatus> {
  const key = `${userId}:${record.createdAt}:${record.wrappedBlob}`;
  const active = ensureJobs.get(key);
  if (active) return active;

  const operation = ensurePinContinuityOnce(userId, record);
  ensureJobs.set(key, operation);
  void operation.finally(() => {
    if (ensureJobs.get(key) === operation) ensureJobs.delete(key);
  });
  return operation;
}

export type PinContinuityPublishResult =
  | 'published'
  | 'matched'
  | 'master_key_unavailable'
  | 'write_failed'
  | 'readback_failed'
  | 'invalid'
  | 'mismatch'
  | 'unavailable';

export async function publishPinContinuity(
  userId: string,
  record: PortablePinRecord,
): Promise<PinContinuityPublishResult> {
  const status = await ensurePinContinuity(userId, record);
  if (status === 'locked') return 'master_key_unavailable';
  return status;
}

export type PinContinuityRestore =
  | { status: 'restored'; record: PortablePinRecord }
  | { status: 'absent' }
  | { status: 'locked' }
  | { status: 'unavailable' }
  | { status: 'invalid' };

export async function restorePinContinuity(
  userId: string,
): Promise<PinContinuityRestore> {
  const envelope = await fetchRemotePinContinuity();
  if (envelope === 'unavailable') return { status: 'unavailable' };
  if (envelope === 'invalid') return { status: 'invalid' };
  if (!envelope) return { status: 'absent' };

  const masterKey = getSessionMasterKey();
  if (!masterKey) return { status: 'locked' };

  const record = await openPinContinuityRecord(
    envelope,
    userId,
    masterKey,
  );
  if (!record) return { status: 'invalid' };
  return { status: 'restored', record };
}

export function clearPinContinuitySingleFlightForTests(): void {
  ensureJobs.clear();
}
