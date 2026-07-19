import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storedRow: { value: null as any },
  upsertOptions: { value: null as any },
  selectCount: { value: 0 },
  masterKey: { value: null as CryptoKey | null },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table !== 'conversation_archive_keys') throw new Error(`Unexpected table: ${table}`);

      const builder: any = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => {
          mocks.selectCount.value += 1;
          return { data: mocks.storedRow.value, error: null };
        }),
        upsert: vi.fn(async (row: any, options: any) => {
          mocks.upsertOptions.value = options;
          if (!mocks.storedRow.value) {
            mocks.storedRow.value = { wrapped_key: row.wrapped_key };
          }
          return { error: null };
        }),
      };

      return builder;
    }),
    rpc: vi.fn(),
  },
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  getSessionMasterKey: () => mocks.masterKey.value,
  getSessionUserId: () => '00000000-0000-4000-8000-000000000002',
}));

vi.mock('@/lib/messaging/archive/archivePrefs', () => ({
  isArchiveBackupEnabled: () => true,
}));

import { decryptArchive, encryptArchive, isArchivePayload } from '../archiveKey';

beforeEach(async () => {
  mocks.storedRow.value = null;
  mocks.upsertOptions.value = null;
  mocks.selectCount.value = 0;
  mocks.masterKey.value = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
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
});
