import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type VaultRow = { version: number; ciphertext: string; iv: string };

const store: {
  row: VaultRow | null;
  upsertCalls: number;
  deleteFails: boolean;
} = {
  row: null,
  upsertCalls: 0,
  deleteFails: false,
};

let masterKey: CryptoKey | null = null;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'aegis_pin_continuity_has') {
        return { data: store.row !== null, error: null };
      }
      if (fn === 'aegis_pin_continuity_get') {
        return { data: store.row ? [store.row] : [], error: null };
      }
      if (fn === 'aegis_pin_continuity_upsert') {
        store.upsertCalls += 1;
        store.row = {
          version: args?.p_version as number,
          ciphertext: args?.p_ciphertext as string,
          iv: args?.p_iv as string,
        };
        return { data: true, error: null };
      }
      if (fn === 'aegis_pin_continuity_delete') {
        if (store.deleteFails) {
          return { data: null, error: { message: 'offline' } };
        }
        store.row = null;
        return { data: true, error: null };
      }
      return { data: null, error: { message: 'unknown rpc' } };
    },
    functions: {
      invoke: async () => ({ data: { ok: true }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          limit: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  getSessionMasterKey: () => masterKey,
}));

import {
  clearPinContinuitySingleFlightForTests,
  deleteRemotePinContinuity,
  ensurePinContinuity,
  hasRemotePinContinuity,
  openPinContinuityRecord,
  publishPinContinuity,
  restorePinContinuity,
  sealPinContinuityRecord,
  validatePortablePinRecord,
  type PortablePinRecord,
} from '@/lib/crypto/pinContinuityVault';
import { __test__ } from '@/hooks/useChatPin';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

function base64Bytes(length: number, fill: number): string {
  const bytes = new Uint8Array(length);
  bytes.fill(fill);
  return btoa(String.fromCharCode(...bytes));
}

async function randomMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function sampleRecord(
  id = USER_ID,
  overrides: Partial<PortablePinRecord> = {},
): PortablePinRecord {
  return {
    id,
    version: 3,
    salt: base64Bytes(32, 1),
    iv: base64Bytes(12, 2),
    wrappedBlob: base64Bytes(96, 3),
    createdAt: Date.now() - 1_000,
    ...overrides,
  };
}

describe('coffre de continuité du PIN Aegis', () => {
  beforeEach(async () => {
    store.row = null;
    store.upsertCalls = 0;
    store.deleteFails = false;
    masterKey = await randomMasterKey();
    clearPinContinuitySingleFlightForTests();
    await __test__.removeLocalPin(USER_ID).catch(() => undefined);
  });

  it('effectue un aller-retour AES-GCM avec la Master Key', async () => {
    const record = sampleRecord();
    const envelope = await sealPinContinuityRecord(
      record,
      USER_ID,
      masterKey!,
    );
    await expect(
      openPinContinuityRecord(envelope, USER_ID, masterKey!),
    ).resolves.toEqual(record);
  });

  it('échoue avec une mauvaise Master Key, un autre userId ou un ciphertext altéré', async () => {
    const record = sampleRecord();
    const envelope = await sealPinContinuityRecord(
      record,
      USER_ID,
      masterKey!,
    );

    const wrongKey = await randomMasterKey();
    await expect(
      openPinContinuityRecord(envelope, USER_ID, wrongKey),
    ).resolves.toBeNull();
    await expect(
      openPinContinuityRecord(envelope, OTHER_ID, masterKey!),
    ).resolves.toBeNull();

    const bytes = Uint8Array.from(
      atob(envelope.ciphertext),
      (character) => character.charCodeAt(0),
    );
    bytes[0] ^= 0xff;
    const tampered = {
      ...envelope,
      ciphertext: btoa(String.fromCharCode(...bytes)),
    };
    await expect(
      openPinContinuityRecord(tampered, USER_ID, masterKey!),
    ).resolves.toBeNull();
  });

  it('impose les tailles exactes du sel et des IV', async () => {
    expect(validatePortablePinRecord(
      sampleRecord(USER_ID, { salt: base64Bytes(31, 1) }),
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(
      sampleRecord(USER_ID, { iv: base64Bytes(11, 2) }),
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(
      sampleRecord(USER_ID, { wrappedBlob: base64Bytes(16, 3) }),
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(
      sampleRecord(USER_ID, { createdAt: Date.now() + 60 * 60_000 }),
      USER_ID,
    )).toBeNull();

    const envelope = await sealPinContinuityRecord(
      sampleRecord(),
      USER_ID,
      masterKey!,
    );
    await expect(openPinContinuityRecord(
      { ...envelope, iv: base64Bytes(11, 5) },
      USER_ID,
      masterKey!,
    )).resolves.toBeNull();
  });

  it('rejette un record déchiffré mal formé', () => {
    expect(validatePortablePinRecord(
      { ...sampleRecord(), id: OTHER_ID },
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(
      { ...sampleRecord(), version: 2 },
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(
      { ...sampleRecord(), salt: '!!!' },
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(
      { ...sampleRecord(), createdAt: 'now' },
      USER_ID,
    )).toBeNull();
    expect(validatePortablePinRecord(null, USER_ID)).toBeNull();
  });

  it('ne publie aucun PIN ni vérificateur directement lisible par Supabase', async () => {
    await __test__.saveLocalPin(USER_ID, '135790');
    const record = (await __test__.loadLocalPin(USER_ID))!;

    await expect(publishPinContinuity(USER_ID, record))
      .resolves.toBe('published');

    const payload = JSON.stringify(store.row);
    expect(payload).not.toContain('135790');
    expect(payload).not.toContain(record.salt);
    expect(payload).not.toContain(record.iv);
    expect(payload).not.toContain(record.wrappedBlob);
  });

  it('stabilise automatiquement un PIN local existant', async () => {
    await __test__.saveLocalPin(USER_ID, '246802');
    expect(store.row).toBeNull();

    const resolved = await __test__.resolvePinRecord(USER_ID);

    expect(resolved.remote).toBe('published');
    expect(resolved.record).not.toBeNull();
    expect(store.row).not.toBeNull();
    expect(store.upsertCalls).toBe(1);
  });

  it('restaure le même PIN après purge d’IndexedDB', async () => {
    await __test__.saveLocalPin(USER_ID, '246802');
    const first = await __test__.resolvePinRecord(USER_ID);
    const record = first.record!;

    await __test__.removeLocalPin(USER_ID);
    expect(await __test__.loadLocalPin(USER_ID)).toBeNull();

    const restored = await __test__.resolvePinRecord(USER_ID);
    expect(restored.remote).toBe('restored');
    expect(restored.record?.wrappedBlob).toBe(record.wrappedBlob);
    await expect(
      __test__.verifyLocalPin(USER_ID, '246802'),
    ).resolves.toBe(true);
    await expect(
      __test__.verifyLocalPin(USER_ID, '111111'),
    ).resolves.toBe(false);
  });

  it('refuse de remplacer silencieusement une continuité différente', async () => {
    const first = sampleRecord();
    const second = sampleRecord(USER_ID, {
      wrappedBlob: base64Bytes(96, 9),
      createdAt: Date.now(),
    });

    await expect(ensurePinContinuity(USER_ID, first))
      .resolves.toBe('published');
    const originalEnvelope = { ...store.row! };

    await expect(ensurePinContinuity(USER_ID, second))
      .resolves.toBe('mismatch');
    expect(store.row).toEqual(originalEnvelope);
    expect(store.upsertCalls).toBe(1);
  });

  it('mutualise les publications concurrentes du même PIN', async () => {
    const record = sampleRecord();

    const results = await Promise.all([
      ensurePinContinuity(USER_ID, record),
      ensurePinContinuity(USER_ID, record),
      ensurePinContinuity(USER_ID, record),
    ]);

    expect(results).toEqual(['published', 'published', 'published']);
    expect(store.upsertCalls).toBe(1);
  });

  it('garde le gate fermé tant que la Master Key n’est pas restaurée', async () => {
    await __test__.saveLocalPin(USER_ID, '369121');
    const record = (await __test__.loadLocalPin(USER_ID))!;
    await publishPinContinuity(USER_ID, record);
    await __test__.removeLocalPin(USER_ID);

    masterKey = null;
    const resolved = await __test__.resolvePinRecord(USER_ID);
    expect(resolved.record).toBeNull();
    expect(resolved.remote).toBe('locked');
  });

  it('refuse de publier sans Master Key de session', async () => {
    masterKey = null;
    await expect(publishPinContinuity(USER_ID, sampleRecord()))
      .resolves.toBe('master_key_unavailable');
    expect(store.row).toBeNull();
  });

  it('supprime et vérifie le coffre distant', async () => {
    await expect(ensurePinContinuity(USER_ID, sampleRecord()))
      .resolves.toBe('published');
    expect(await hasRemotePinContinuity()).toBe(true);

    await expect(deleteRemotePinContinuity()).resolves.toBe(true);
    expect(await hasRemotePinContinuity()).toBe(false);
    await expect(restorePinContinuity(USER_ID))
      .resolves.toEqual({ status: 'absent' });
  });

  it('conserve le PIN local lorsque la suppression distante échoue', () => {
    const source = readFileSync(
      resolve('src/hooks/useChatPin.ts'),
      'utf8',
    );
    const remoteDelete = source.indexOf(
      'const vaultCleared = await deleteRemotePinContinuity()',
    );
    const localDelete = source.indexOf(
      'await removeLocalPin(user.id)',
      remoteDelete,
    );

    expect(remoteDelete).toBeGreaterThan(-1);
    expect(localDelete).toBeGreaterThan(remoteDelete);
    expect(source).toContain('Votre PIN local est conservé.');
  });

  it('ne déverrouille un setup neuf qu’après publication et readback', () => {
    const source = readFileSync(
      resolve('src/hooks/useChatPin.ts'),
      'utf8',
    );
    const ensure = source.indexOf(
      'const continuity = await ensurePinContinuity(user.id, record)',
    );
    const rollback = source.indexOf(
      'await removeLocalPin(user.id).catch(() => undefined)',
      ensure,
    );
    const unlock = source.indexOf(
      'unlockedRef.current = true',
      ensure,
    );

    expect(ensure).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(ensure);
    expect(unlock).toBeGreaterThan(rollback);
    expect(source).toContain(
      "continuity !== 'published' && continuity !== 'matched'",
    );
  });

  it('préserve le miroir Keychain/Keystore natif', () => {
    const source = readFileSync(
      resolve('src/hooks/useChatPin.ts'),
      'utf8',
    );
    expect(source).toContain('secureSetSecret(');
    expect(source).toContain('PIN_NATIVE_SECURE_MIRROR_FAILED');
    expect(source).toContain('secureGetSecret(');
  });
});
