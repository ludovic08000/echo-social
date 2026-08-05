import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultRow: { version: number; ciphertext: string; iv: string } | null | { current: unknown } = null;
void vaultRow;

const store: { row: { version: number; ciphertext: string; iv: string } | null } = { row: null };
let masterKey: CryptoKey | null = null;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'aegis_pin_continuity_has') return { data: store.row !== null, error: null };
      if (fn === 'aegis_pin_continuity_get') return { data: store.row ? [store.row] : [], error: null };
      if (fn === 'aegis_pin_continuity_upsert') {
        store.row = {
          version: args?.p_version as number,
          ciphertext: args?.p_ciphertext as string,
          iv: args?.p_iv as string,
        };
        return { data: true, error: null };
      }
      if (fn === 'aegis_pin_continuity_delete') {
        store.row = null;
        return { data: true, error: null };
      }
      return { data: null, error: { message: 'unknown rpc' } };
    },
    functions: { invoke: async () => ({ data: { ok: true }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  getSessionMasterKey: () => masterKey,
}));

import {
  deleteRemotePinContinuity,
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

async function randomMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function sampleRecord(id = USER_ID): PortablePinRecord {
  return {
    id,
    version: 3,
    salt: btoa('salt-bytes-000000'),
    iv: btoa('iv-bytes-123'),
    wrappedBlob: btoa('wrapped-verifier-blob'),
    createdAt: 1_700_000_000_000,
  };
}

describe('coffre de continuité du PIN Aegis', () => {
  beforeEach(async () => {
    store.row = null;
    masterKey = await randomMasterKey();
    await __test__.removeLocalPin(USER_ID).catch(() => undefined);
  });

  it('effectue un aller-retour AES-GCM avec la Master Key', async () => {
    const record = sampleRecord();
    const envelope = await sealPinContinuityRecord(record, USER_ID, masterKey!);
    await expect(openPinContinuityRecord(envelope, USER_ID, masterKey!)).resolves.toEqual(record);
  });

  it('échoue avec une mauvaise Master Key, un autre userId ou un ciphertext altéré', async () => {
    const record = sampleRecord();
    const envelope = await sealPinContinuityRecord(record, USER_ID, masterKey!);

    const wrongKey = await randomMasterKey();
    await expect(openPinContinuityRecord(envelope, USER_ID, wrongKey)).resolves.toBeNull();
    await expect(openPinContinuityRecord(envelope, OTHER_ID, masterKey!)).resolves.toBeNull();

    const bytes = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    const tampered = { ...envelope, ciphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(openPinContinuityRecord(tampered, USER_ID, masterKey!)).resolves.toBeNull();
  });

  it('rejette un record déchiffré mal formé', () => {
    expect(validatePortablePinRecord({ ...sampleRecord(), id: OTHER_ID }, USER_ID)).toBeNull();
    expect(validatePortablePinRecord({ ...sampleRecord(), version: 2 }, USER_ID)).toBeNull();
    expect(validatePortablePinRecord({ ...sampleRecord(), salt: '!!!' }, USER_ID)).toBeNull();
    expect(validatePortablePinRecord({ ...sampleRecord(), createdAt: 'now' }, USER_ID)).toBeNull();
    expect(validatePortablePinRecord(null, USER_ID)).toBeNull();
  });

  it('ne publie aucun PIN ni dérivé direct du PIN dans le payload serveur', async () => {
    await __test__.saveLocalPin(USER_ID, '135790');
    const record = (await __test__.loadLocalPin(USER_ID))!;
    await expect(publishPinContinuity(USER_ID, record as unknown as PortablePinRecord))
      .resolves.toBe('published');

    const payload = JSON.stringify(store.row);
    expect(payload).not.toContain('135790');
    expect(payload).not.toContain(record.salt);
    expect(payload).not.toContain(record.wrappedBlob);
  });

  it('restaure le même PIN après purge d’IndexedDB', async () => {
    await __test__.saveLocalPin(USER_ID, '246802');
    const record = (await __test__.loadLocalPin(USER_ID))!;
    await publishPinContinuity(USER_ID, record as unknown as PortablePinRecord);

    // Purge navigateur simulée
    await __test__.removeLocalPin(USER_ID);
    expect(await __test__.loadLocalPin(USER_ID)).toBeNull();

    const resolved = await __test__.resolvePinRecord(USER_ID);
    expect(resolved.remote).toBe('restored');
    expect(resolved.record?.wrappedBlob).toBe(record.wrappedBlob);
    await expect(__test__.verifyLocalPin(USER_ID, '246802')).resolves.toBe(true);
    await expect(__test__.verifyLocalPin(USER_ID, '111111')).resolves.toBe(false);
  });

  it('garde le gate fermé tant que la Master Key n’est pas restaurée', async () => {
    await __test__.saveLocalPin(USER_ID, '369121');
    const record = (await __test__.loadLocalPin(USER_ID))!;
    await publishPinContinuity(USER_ID, record as unknown as PortablePinRecord);
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

  it('supprime le coffre distant et le record local sur reset', async () => {
    await __test__.saveLocalPin(USER_ID, '456123');
    const record = (await __test__.loadLocalPin(USER_ID))!;
    await publishPinContinuity(USER_ID, record as unknown as PortablePinRecord);
    expect(await hasRemotePinContinuity()).toBe(true);

    await __test__.removeLocalPin(USER_ID);
    await expect(deleteRemotePinContinuity()).resolves.toBe(true);
    expect(await hasRemotePinContinuity()).toBe(false);
    await expect(restorePinContinuity(USER_ID)).resolves.toEqual({ status: 'absent' });
  });
});
