/**
 * Aegis PIN continuity vault.
 *
 * Invariant : le serveur ne détient qu'une enveloppe AES-GCM scellée par la
 * Master Key aléatoire de 32 octets du compte. Le PIN à 6 chiffres n'est jamais
 * envoyé, ni dérivé côté serveur : sans la Master Key, l'enveloppe est inerte.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { getSessionMasterKey } from './accountKeyBackup';

export const PIN_CONTINUITY_VERSION = 1 as const;
const LOCAL_PIN_VERSION = 3 as const;
const IV_LENGTH = 12;
const MAX_CIPHERTEXT_B64 = 8192;
const MAX_FIELD_B64 = 2048;

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

export function pinContinuityAad(userId: string): Uint8Array {
  return new hardGlobals.TextEncoder().encode(`FORSURE-PIN-CONTINUITY-v1|${userId}`);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return hardGlobals.btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = hardGlobals.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isBoundedBase64(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

/** Valide strictement le record déchiffré ; toute anomalie échoue fermé. */
export function validatePortablePinRecord(
  candidate: unknown,
  userId: string,
): PortablePinRecord | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Partial<PortablePinRecord>;
  if (record.id !== userId) return null;
  if (record.version !== LOCAL_PIN_VERSION) return null;
  if (!isBoundedBase64(record.salt, 4, MAX_FIELD_B64)) return null;
  if (!isBoundedBase64(record.iv, 4, MAX_FIELD_B64)) return null;
  if (!isBoundedBase64(record.wrappedBlob, 4, MAX_FIELD_B64)) return null;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;
  return {
    id: record.id,
    version: LOCAL_PIN_VERSION,
    salt: record.salt,
    iv: record.iv,
    wrappedBlob: record.wrappedBlob,
    createdAt: record.createdAt,
  };
}

/** Scelle le record local sous la Master Key du compte. */
export async function sealPinContinuityRecord(
  record: PortablePinRecord,
  userId: string,
  masterKey: CryptoKey,
): Promise<PinContinuityEnvelope> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aad = pinContinuityAad(userId);
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad.slice().buffer,
      tagLength: 128,
    },
    masterKey,
    new hardGlobals.TextEncoder().encode(hardGlobals.jsonStringify(record)),
  );
  return {
    version: PIN_CONTINUITY_VERSION,
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
  };
}

/** Ouvre l'enveloppe et revalide le record ; renvoie null en cas d'échec. */
export async function openPinContinuityRecord(
  envelope: PinContinuityEnvelope,
  userId: string,
  masterKey: CryptoKey,
): Promise<PortablePinRecord | null> {
  if (envelope?.version !== PIN_CONTINUITY_VERSION) return null;
  if (!isBoundedBase64(envelope.ciphertext, 24, MAX_CIPHERTEXT_B64)) return null;
  if (!isBoundedBase64(envelope.iv, 12, 64)) return null;
  try {
    const plaintext = await hardCrypto.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(envelope.iv) as Uint8Array<ArrayBuffer>,
        additionalData: pinContinuityAad(userId).slice().buffer,
        tagLength: 128,
      },
      masterKey,
      fromBase64(envelope.ciphertext) as Uint8Array<ArrayBuffer>,
    );
    const decoded = hardGlobals.jsonParse(new hardGlobals.TextDecoder().decode(plaintext));
    return validatePortablePinRecord(decoded, userId);
  } catch {
    return null;
  }
}

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };

function rpcClient(): RpcClient {
  return supabase as unknown as RpcClient;
}

export async function hasRemotePinContinuity(): Promise<boolean | 'unavailable'> {
  try {
    const client = rpcClient();
    const { data, error } = await client.rpc('aegis_pin_continuity_has');
    if (error) return 'unavailable';
    return data === true;
  } catch {
    return 'unavailable';
  }
}

export async function fetchRemotePinContinuity(): Promise<PinContinuityEnvelope | null | 'unavailable'> {
  try {
    const client = rpcClient();
    const { data, error } = await client.rpc('aegis_pin_continuity_get');
    if (error) return 'unavailable';
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    const envelope = row as Partial<PinContinuityEnvelope>;
    if (envelope.version !== PIN_CONTINUITY_VERSION) return null;
    if (typeof envelope.ciphertext !== 'string' || typeof envelope.iv !== 'string') return null;
    return { version: PIN_CONTINUITY_VERSION, ciphertext: envelope.ciphertext, iv: envelope.iv };
  } catch {
    return 'unavailable';
  }
}

async function upsertRemotePinContinuity(envelope: PinContinuityEnvelope): Promise<boolean> {
  try {
    const client = rpcClient();
    const { error } = await client.rpc('aegis_pin_continuity_upsert', {
      p_version: envelope.version,
      p_ciphertext: envelope.ciphertext,
      p_iv: envelope.iv,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function deleteRemotePinContinuity(): Promise<boolean> {
  try {
    const client = rpcClient();
    const { error } = await client.rpc('aegis_pin_continuity_delete');
    return !error;
  } catch {
    return false;
  }
}

export type PinContinuityPublishResult =
  | 'published'
  | 'master_key_unavailable'
  | 'write_failed'
  | 'readback_failed';

/**
 * Publie le record local dans le coffre puis relit et déchiffre l'enveloppe.
 * Sans cette relecture réussie, la continuité n'est pas considérée durable.
 */
export async function publishPinContinuity(
  userId: string,
  record: PortablePinRecord,
): Promise<PinContinuityPublishResult> {
  const masterKey = getSessionMasterKey();
  if (!masterKey) return 'master_key_unavailable';

  const envelope = await sealPinContinuityRecord(record, userId, masterKey);
  const written = await upsertRemotePinContinuity(envelope);
  if (!written) return 'write_failed';

  const stored = await fetchRemotePinContinuity();
  if (!stored || stored === 'unavailable') return 'readback_failed';
  const reopened = await openPinContinuityRecord(stored, userId, masterKey);
  if (!reopened || reopened.wrappedBlob !== record.wrappedBlob) return 'readback_failed';
  return 'published';
}

export type PinContinuityRestore =
  | { status: 'restored'; record: PortablePinRecord }
  | { status: 'absent' }
  | { status: 'locked' }
  | { status: 'unavailable' }
  | { status: 'invalid' };

/** Récupère et déchiffre le record distant lorsque la Master Key est en RAM. */
export async function restorePinContinuity(userId: string): Promise<PinContinuityRestore> {
  const envelope = await fetchRemotePinContinuity();
  if (envelope === 'unavailable') return { status: 'unavailable' };
  if (!envelope) return { status: 'absent' };

  const masterKey = getSessionMasterKey();
  if (!masterKey) return { status: 'locked' };

  const record = await openPinContinuityRecord(envelope, userId, masterKey);
  if (!record) return { status: 'invalid' };
  return { status: 'restored', record };
}
