import { beforeEach, describe, expect, it, vi } from 'vitest';

type BackupRow = {
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
};

type CloudRow = Record<string, unknown>;

const cloud = vi.hoisted(() => ({
  backupRow: { value: null as BackupRow | null },
  conversationKeys: new Map<string, CloudRow>(),
  messageArchives: new Map<string, string>(),
  parentArchives: new Map<string, string>(),
}));

vi.mock('@/lib/secureStore', () => ({
  secureGetSecret: vi.fn(async () => null),
  secureSetSecret: vi.fn(async () => undefined),
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  getSessionMasterKey: () => null,
  getSessionUserId: () => null,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const filters: Record<string, string> = {};
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          filters[column] = value;
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (table === 'user_backups') {
            return { data: cloud.backupRow.value, error: null };
          }
          if (table === 'conversation_archive_keys') {
            const key = `${filters.user_id}:${filters.conversation_id}`;
            return { data: cloud.conversationKeys.get(key) ?? null, error: null };
          }
          if (table === 'message_archives') {
            const key = `${filters.user_id}:${filters.message_id}`;
            const archiveBody = cloud.messageArchives.get(key);
            return {
              data: archiveBody ? { archive_body: archiveBody } : null,
              error: null,
            };
          }
          if (table === 'messages') {
            const archiveBody = cloud.parentArchives.get(filters.id);
            return {
              data: archiveBody ? { archive_body: archiveBody } : null,
              error: null,
            };
          }
          throw new Error(`Unexpected table read: ${table}`);
        }),
        upsert: vi.fn(async (row: CloudRow) => {
          if (table === 'conversation_archive_keys') {
            const key = `${String(row.user_id)}:${String(row.conversation_id)}`;
            if (!cloud.conversationKeys.has(key)) cloud.conversationKeys.set(key, row);
            return { error: null };
          }
          if (table === 'message_archives') {
            const key = `${String(row.user_id)}:${String(row.message_id)}`;
            if (!cloud.messageArchives.has(key)) {
              cloud.messageArchives.set(key, String(row.archive_body));
            }
            return { error: null };
          }
          throw new Error(`Unexpected table write: ${table}`);
        }),
      };
      return builder;
    }),
    rpc: vi.fn(async (name: string, args: Record<string, string>) => {
      if (name !== 'set_message_archive_body') return { data: null, error: null };
      if (!cloud.parentArchives.has(args.p_message_id)) {
        cloud.parentArchives.set(args.p_message_id, args.p_archive_body);
      }
      return { data: true, error: null };
    }),
  },
}));

import { bufferToBase64 } from '@/lib/crypto/utils';
import { masterKeyAADLabel } from '@/lib/crypto/masterKeyFormat';
import {
  clearArchiveMasterKeySession,
  initializeArchiveMasterKeyFromPassword,
} from '@/lib/crypto/archiveMasterKey';
import {
  archiveBubbleForUser,
  clearArchiveKeyCache,
  recoverBubbleFromArchive,
} from '@/lib/messaging/archive/archiveKey';

const USER_ID = '00000000-0000-4000-8000-000000000101';
const CONVERSATION_ID = '00000000-0000-4000-8000-000000000102';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000103';
const PASSWORD = 'correct horse battery staple';

function toBase64(value: ArrayBuffer | Uint8Array): string {
  if (value instanceof Uint8Array) {
    return bufferToBase64(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    );
  }
  return bufferToBase64(value);
}

async function createPasswordWrappedMasterKey(password: string): Promise<BackupRow> {
  const rawMasterKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${password}::forsure::${USER_ID}`),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const wrapped = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(masterKeyAADLabel(USER_ID, 'account')),
    },
    wrappingKey,
    rawMasterKey,
  );
  rawMasterKey.fill(0);
  return {
    salt: toBase64(salt),
    wrapped_master_key: toBase64(wrapped),
    master_key_iv: toBase64(iv),
  };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB deletion blocked: ${name}`));
  });
}

beforeEach(async () => {
  clearArchiveKeyCache();
  clearArchiveMasterKeySession();
  cloud.conversationKeys.clear();
  cloud.messageArchives.clear();
  cloud.parentArchives.clear();
  await deleteDatabase('forsure-archive-master-key');
  cloud.backupRow.value = await createPasswordWrappedMasterKey(PASSWORD);
});

describe('message recovery after a complete browser wipe', () => {
  it('restores the account Master Key with the password and reads the cloud archive', async () => {
    await expect(initializeArchiveMasterKeyFromPassword(PASSWORD, USER_ID))
      .resolves.toBe('restored');
    await expect(archiveBubbleForUser({
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      plaintext: 'Toujours lisible après effacement',
      ensureParent: true,
    })).resolves.toBe(true);

    clearArchiveKeyCache();
    clearArchiveMasterKeySession();
    await deleteDatabase('forsure-archive-master-key');

    await expect(recoverBubbleFromArchive({
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
    })).resolves.toBeNull();
    await expect(initializeArchiveMasterKeyFromPassword('mauvais mot de passe', USER_ID))
      .resolves.toBe('blocked');
    await expect(initializeArchiveMasterKeyFromPassword(PASSWORD, USER_ID))
      .resolves.toBe('restored');
    await expect(recoverBubbleFromArchive({
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
    })).resolves.toBe('Toujours lisible après effacement');
  });
});
