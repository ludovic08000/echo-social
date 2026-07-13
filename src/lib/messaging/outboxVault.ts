import { STORE_KEYS, STORE_OUTBOX } from '@/lib/crypto/constants';
import { reqToPromise, runTx, txDelete, txGet, txPut } from '@/lib/crypto/indexedDbTx';

const OUTBOX_KEY_PREFIX = 'outbox-vault-key::';
const OUTBOX_AAD_PREFIX = 'FORSURE-OUTBOX-v1|';
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_MAX_ENTRIES = 100;

export type OutboxStatus =
  | 'draft'
  | 'pending_local'
  | 'encrypting'
  | 'waiting_secure_channel'
  | 'sending'
  | 'sent'
  | 'retry_pending'
  | 'failed_visible';

export interface OutboxExtra {
  view_once?: boolean;
  document_url?: string | null;
  document_name?: string | null;
  document_mime?: string | null;
  document_size_bytes?: number | null;
}

export interface OutboxPayload {
  localId: string;
  traceId: string;
  conversationId: string;
  senderId: string;
  plaintext: string;
  encryptedBody: string | null;
  imageUrl: string | null;
  extra?: OutboxExtra;
  status: OutboxStatus;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  reservedServerId: string | null;
}

interface OutboxKeyRecord {
  id: string;
  key: CryptoKey;
  createdAt: number;
}

interface StoredOutboxRecord {
  localId: string;
  userId: string;
  conversationId: string;
  updatedAt: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  version: 1;
}

const keyPromises = new Map<string, Promise<CryptoKey>>();
const writeChains = new Map<string, Promise<void>>();

function aadFor(userId: string, conversationId: string, localId: string): Uint8Array {
  return new TextEncoder().encode(
    `${OUTBOX_AAD_PREFIX}${userId}|${conversationId}|${localId}`,
  );
}

async function createOrLoadOutboxKey(userId: string): Promise<CryptoKey> {
  const id = `${OUTBOX_KEY_PREFIX}${userId}`;
  const existing = await txGet<OutboxKeyRecord>(STORE_KEYS, id);
  if (existing?.key) return existing.key;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  // Re-read before writing because another tab may have created the key while
  // WebCrypto was generating ours.
  const raced = await txGet<OutboxKeyRecord>(STORE_KEYS, id);
  if (raced?.key) return raced.key;

  await txPut(STORE_KEYS, { id, key, createdAt: Date.now() } satisfies OutboxKeyRecord);
  return key;
}

async function getOrCreateOutboxKey(userId: string): Promise<CryptoKey> {
  let promise = keyPromises.get(userId);
  if (!promise) {
    promise = createOrLoadOutboxKey(userId).catch((error) => {
      keyPromises.delete(userId);
      throw error;
    });
    keyPromises.set(userId, promise);
  }
  return promise;
}

function enqueueWrite(localId: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeChains.get(localId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (writeChains.get(localId) === next) writeChains.delete(localId);
    });
  writeChains.set(localId, next);
  return next;
}

async function waitForPendingWrite(localId: string): Promise<void> {
  await (writeChains.get(localId) ?? Promise.resolve()).catch(() => {});
}

async function encryptPayload(userId: string, payload: OutboxPayload): Promise<StoredOutboxRecord> {
  const key = await getOrCreateOutboxKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aadFor(userId, payload.conversationId, payload.localId),
      tagLength: 128,
    },
    key,
    plaintext,
  );

  return {
    localId: payload.localId,
    userId,
    conversationId: payload.conversationId,
    updatedAt: payload.updatedAt,
    iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
    ciphertext,
    version: 1,
  };
}

async function decryptRecord(userId: string, record: StoredOutboxRecord): Promise<OutboxPayload | null> {
  if (record.userId !== userId || record.version !== 1) return null;
  try {
    const key = await getOrCreateOutboxKey(userId);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(record.iv),
        additionalData: aadFor(userId, record.conversationId, record.localId),
        tagLength: 128,
      },
      key,
      record.ciphertext,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as OutboxPayload;
    if (
      payload.localId !== record.localId ||
      payload.conversationId !== record.conversationId ||
      payload.senderId !== userId
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function putOutboxPayload(userId: string, payload: OutboxPayload): Promise<void> {
  if (!userId || !payload.localId || payload.senderId !== userId) return Promise.resolve();
  const normalized: OutboxPayload = {
    ...payload,
    updatedAt: Date.now(),
  };

  return enqueueWrite(payload.localId, async () => {
    await txPut(STORE_OUTBOX, await encryptPayload(userId, normalized));
    void pruneOutbox(userId).catch(() => {});
  });
}

export async function patchOutboxPayload(
  userId: string,
  localId: string,
  patch: Partial<OutboxPayload>,
): Promise<OutboxPayload | null> {
  await waitForPendingWrite(localId);
  const current = await getOutboxPayload(userId, localId);
  if (!current) return null;
  const next: OutboxPayload = {
    ...current,
    ...patch,
    localId: current.localId,
    conversationId: current.conversationId,
    senderId: current.senderId,
    updatedAt: Date.now(),
  };
  await putOutboxPayload(userId, next);
  return next;
}

export async function getOutboxPayload(
  userId: string,
  localId: string,
): Promise<OutboxPayload | null> {
  await waitForPendingWrite(localId);
  const record = await txGet<StoredOutboxRecord>(STORE_OUTBOX, localId);
  if (!record) return null;
  const payload = await decryptRecord(userId, record);
  if (!payload) {
    await enqueueWrite(localId, () => txDelete(STORE_OUTBOX, localId)).catch(() => {});
  }
  return payload;
}

export async function listOutboxPayloads(
  userId: string,
  conversationId?: string,
): Promise<OutboxPayload[]> {
  await Promise.all([...writeChains.values()].map((promise) => promise.catch(() => {})));
  const records = await runTx([STORE_OUTBOX], 'readonly', (tx) => {
    const store = tx.objectStore(STORE_OUTBOX);
    if (conversationId && store.indexNames.contains('by-user-conversation')) {
      return reqToPromise(
        store.index('by-user-conversation').getAll([userId, conversationId]) as IDBRequest<StoredOutboxRecord[]>,
      );
    }
    return reqToPromise(store.getAll() as IDBRequest<StoredOutboxRecord[]>);
  });

  const decrypted = await Promise.all(
    records
      .filter((record) => record.userId === userId)
      .map((record) => decryptRecord(userId, record)),
  );

  return decrypted
    .filter((payload): payload is OutboxPayload => payload !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
}

export function deleteOutboxPayload(localId: string): Promise<void> {
  return enqueueWrite(localId, () => txDelete(STORE_OUTBOX, localId));
}

export async function pruneOutbox(userId: string): Promise<void> {
  const now = Date.now();
  const records = await runTx([STORE_OUTBOX], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_OUTBOX).getAll() as IDBRequest<StoredOutboxRecord[]>),
  );
  const mine = records
    .filter((record) => record.userId === userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const expired = mine.filter((record, index) =>
    now - record.updatedAt > OUTBOX_MAX_AGE_MS || index >= OUTBOX_MAX_ENTRIES,
  );
  await Promise.all(expired.map((record) => deleteOutboxPayload(record.localId)));
}

export const __test__ = { aadFor };
