import { beforeEach, describe, expect, it, vi } from 'vitest';

type DuplicateSafeUpsertOptions = {
  onConflict: string;
  ignoreDuplicates: boolean;
};

type MockQueryBuilder = {
  select: (...args: unknown[]) => MockQueryBuilder;
  eq: (...args: unknown[]) => MockQueryBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  upsert?: (
    row: Record<string, string>,
    options: DuplicateSafeUpsertOptions,
  ) => Promise<{ error: null }>;
};

const mocks = vi.hoisted(() => ({
  storedRow: { value: null as { wrapped_key: string } | null },
  upsertOptions: { value: null as DuplicateSafeUpsertOptions | null },
  selectCount: { value: 0 },
  masterKey: { value: null as CryptoKey | null },
  personalArchiveBody: { value: null as string | null },
  parentArchiveBody: { value: null as string | null },
  archiveUpsertOptions: { value: null as DuplicateSafeUpsertOptions | null },
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'conversation_archive_keys') {
        const builder: MockQueryBuilder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => {
            mocks.selectCount.value += 1;
            return { data: mocks.storedRow.value, error: null };
          }),
          upsert: vi.fn(async (
            row: Record<string, string>,
            options: DuplicateSafeUpsertOptions,
          ) => {
            mocks.upsertOptions.value = options;
            if (!mocks.storedRow.value && row.wrapped_key) {
              mocks.storedRow.value = { wrapped_key: row.wrapped_key };
            }
            return { error: null };
          }),
        };
        return builder;
      }

      if (table === 'message_archives') {
        const builder: MockQueryBuilder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: mocks.personalArchiveBody.value
              ? { archive_body: mocks.personalArchiveBody.value }
              : null,
            error: null,
          })),
          upsert: vi.fn(async (
            row: Record<string, string>,
            options: DuplicateSafeUpsertOptions,
          ) => {
            mocks.archiveUpsertOptions.value = options;
            if (!mocks.personalArchiveBody.value && row.archive_body) {
              mocks.personalArchiveBody.value = row.archive_body;
            }
            return { error: null };
          }),
        };
        return builder;
      }

      if (table === 'messages') {
        const builder: MockQueryBuilder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: mocks.parentArchiveBody.value
              ? { archive_body: mocks.parentArchiveBody.value }
              : null,
            error: null,
          })),
        };
        return builder;
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
    rpc: mocks.rpc,
  },
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  getSessionMasterKey: () => mocks.masterKey.value,
  getSessionUserId: () => '00000000-0000-4000-8000-000000000002',
}));

import {
  archiveBubbleForUser,
  clearArchiveKeyCache,
  decryptArchive,
  encryptArchive,
  isArchivePayload,
  setMessageArchiveBody,
} from '../archiveKey';

beforeEach(async () => {
  mocks.storedRow.value = null;
  mocks.upsertOptions.value = null;
  mocks.selectCount.value = 0;
  mocks.personalArchiveBody.value = null;
  mocks.parentArchiveBody.value = null;
  mocks.archiveUpsertOptions.value = null;
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (
    name: string,
    args: { p_archive_body?: string },
  ) => {
    if (name !== 'set_message_archive_body') return { data: [], error: null };
    if (!mocks.parentArchiveBody.value && args.p_archive_body) {
      mocks.parentArchiveBody.value = args.p_archive_body;
      return { data: true, error: null };
    }
    return { data: false, error: null };
  });
  mocks.masterKey.value = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  clearArchiveKeyCache();
  localStorage.clear();
});

describe('archiveKey', () => {
  it('creates archive keys with duplicate-safe upsert and re-reads the stored key', async () => {
    const payload = await encryptArchive(
      'message with media key',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    );

    expect(isArchivePayload(payload)).toBe(true);
    expect(mocks.upsertOptions.value).toEqual({
      onConflict: 'conversation_id,user_id',
      ignoreDuplicates: true,
    });
    expect(mocks.selectCount.value).toBe(2);
    expect(mocks.storedRow.value?.wrapped_key).toEqual(expect.any(String));
  });

  it('binds a bubble archive to its stable message UUID', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000001';
    const userId = '00000000-0000-4000-8000-000000000002';
    const messageId = '00000000-0000-4000-8000-000000000003';
    const payload = await encryptArchive('saved bubble', conversationId, userId, messageId);

    await expect(decryptArchive(payload!, conversationId, userId, messageId))
      .resolves.toBe('saved bubble');
    await expect(decryptArchive(
      payload!,
      conversationId,
      userId,
      '00000000-0000-4000-8000-000000000004',
    )).resolves.toBeNull();
  });

  it('verifies the per-user archive and repairs the immutable sender archive', async () => {
    const input = {
      conversationId: '00000000-0000-4000-8000-000000000011',
      userId: '00000000-0000-4000-8000-000000000002',
      messageId: '00000000-0000-4000-8000-000000000013',
      plaintext: 'bubble durable',
      ensureParent: true,
    };

    await expect(archiveBubbleForUser(input)).resolves.toBe(true);
    expect(mocks.archiveUpsertOptions.value).toEqual({
      onConflict: 'message_id,user_id',
      ignoreDuplicates: true,
    });
    expect(isArchivePayload(mocks.personalArchiveBody.value)).toBe(true);
    expect(mocks.parentArchiveBody.value).toBe(mocks.personalArchiveBody.value);

    // A second idempotent pass sees the already-stored rows as success even
    // though the immutable RPC correctly reports that it changed zero rows.
    await expect(archiveBubbleForUser(input)).resolves.toBe(true);
  });

  it('treats an already-populated parent archive as a verified success', async () => {
    mocks.parentArchiveBody.value = JSON.stringify({
      v: 2,
      iv: 'already-there',
      ct: 'ciphertext',
      context: 'message-id',
    });
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });

    await expect(setMessageArchiveBody(
      '00000000-0000-4000-8000-000000000021',
      'new-immutable-value',
    )).resolves.toBe(true);
  });
});
