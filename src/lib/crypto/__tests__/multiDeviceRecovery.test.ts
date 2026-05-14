import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hardCrypto } from '../cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '../utils';
import { reqToPromise, runTxOn } from '../indexedDbTx';

const supabaseMock = vi.hoisted(() => ({
  state: {
    pubKeys: null as null | { identity_key: string; signing_key: string },
    spkRows: [] as Array<{
      spk_id: number;
      public_key: string;
      signature: string;
      keys_epoch?: number;
    }>,
    serverDeviceSpk: null as null | { spk_id: number; keys_epoch?: number },
    serverOpks: [] as Array<{ opk_id: number }>,
    insertedOpks: [] as unknown[],
    upsertedSpk: null as null | Record<string, unknown>,
    updates: [] as Array<{ table: string; payload: unknown }>,
    deletes: [] as string[],
    bundleCalls: 0,
    countOpks: 0,
    epoch: 1,
  },
  rpc: vi.fn(),
  from: vi.fn(),
  auth: {
    getSession: vi.fn(async () => ({ data: { session: null } })),
    getUser: vi.fn(async () => ({ data: { user: { id: 'bob' } } })),
  },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: supabaseMock.rpc,
    from: supabaseMock.from,
    auth: supabaseMock.auth,
  },
}));

import {
  fetchPrekeyBundleForDevice,
  invalidateDeviceBundleCache,
  refillDeviceOneTimePrekeysIfNeeded,
  repairLocalDevicePrekeys,
} from '../x3dh';

function makeBuilder(table: string) {
  let op: 'select' | 'update' | 'delete' | null = null;
  const result = () => {
    if (op === 'select' && table === 'device_one_time_prekeys') {
      return { data: supabaseMock.state.serverOpks, error: null };
    }
    return { data: null, error: null };
  };
  const builder: Record<string, unknown> = {
    select: vi.fn(() => {
      op = 'select';
      return builder;
    }),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    delete: vi.fn(() => {
      op = 'delete';
      supabaseMock.state.deletes.push(table);
      return builder;
    }),
    update: vi.fn((payload: unknown) => {
      op = 'update';
      supabaseMock.state.updates.push({ table, payload });
      return builder;
    }),
    insert: vi.fn(async (rows: unknown[]) => {
      if (table === 'device_one_time_prekeys') supabaseMock.state.insertedOpks = rows;
      return { error: null };
    }),
    upsert: vi.fn(async (payload: Record<string, unknown>) => {
      if (table === 'device_signed_prekeys') {
        supabaseMock.state.upsertedSpk = payload;
        supabaseMock.state.spkRows = [{
          spk_id: Number(payload.spk_id),
          public_key: String(payload.public_key),
          signature: String(payload.signature),
          keys_epoch: Number(payload.keys_epoch ?? payload.spk_id),
        }];
        supabaseMock.state.serverDeviceSpk = {
          spk_id: Number(payload.spk_id),
          keys_epoch: Number(payload.keys_epoch ?? payload.spk_id),
        };
      }
      return { error: null };
    }),
    maybeSingle: vi.fn(async () => {
      if (table === 'user_public_keys') return { data: supabaseMock.state.pubKeys, error: null };
      if (table === 'device_signed_prekeys') {
        return { data: supabaseMock.state.serverDeviceSpk, error: null };
      }
      if (table === 'message_device_retry_requests') return { data: null, error: null };
      return { data: null, error: null };
    }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  };
  return builder;
}

async function clearSpkStore(): Promise<void> {
  await runTxOn('spk', 'signed-prekeys', 'readwrite', (store) => {
    store.clear();
  });
}

async function generateX25519PublicB64(): Promise<string> {
  const pair = await hardCrypto.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair;
  return bufferToBase64(await hardCrypto.exportKey('raw', pair.publicKey) as ArrayBuffer);
}

async function generateSigningIdentity(): Promise<{ privateKey: CryptoKey; publicB64: string }> {
  const pair = await hardCrypto.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicB64 = bufferToBase64(await hardCrypto.exportKey('raw', pair.publicKey) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicB64 };
}

async function signSpk(signingPrivateKey: CryptoKey, spkPublicB64: string): Promise<string> {
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519' as any,
    signingPrivateKey,
    base64ToBuffer(spkPublicB64),
  ) as ArrayBuffer);
}

beforeEach(async () => {
  await clearSpkStore();
  supabaseMock.state.pubKeys = null;
  supabaseMock.state.spkRows = [];
  supabaseMock.state.serverDeviceSpk = null;
  supabaseMock.state.serverOpks = [];
  supabaseMock.state.insertedOpks = [];
  supabaseMock.state.upsertedSpk = null;
  supabaseMock.state.updates = [];
  supabaseMock.state.deletes = [];
  supabaseMock.state.bundleCalls = 0;
  supabaseMock.state.countOpks = 0;
  supabaseMock.state.epoch = 1;
  supabaseMock.rpc.mockReset();
  supabaseMock.from.mockReset();
  supabaseMock.from.mockImplementation((table: string) => makeBuilder(table));
  supabaseMock.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_device_prekey_bundle') {
      const index = Math.min(supabaseMock.state.bundleCalls, supabaseMock.state.spkRows.length - 1);
      supabaseMock.state.bundleCalls += 1;
      const row = supabaseMock.state.spkRows[index];
      return { data: row ? [row] : [], error: null };
    }
    if (name === 'claim_device_one_time_prekey') return { data: [], error: null };
    if (name === 'count_device_one_time_prekeys') {
      return { data: supabaseMock.state.countOpks, error: null };
    }
    if (name === 'bump_device_keys_epoch') {
      supabaseMock.state.epoch += 1;
      return { data: supabaseMock.state.epoch, error: null };
    }
    return { data: null, error: null };
  });
  invalidateDeviceBundleCache('bob', 'B1', 'test_reset');
});

describe('multi-device X3DH recovery hardening', () => {
  it('stale bundle refetches once and succeeds with a valid SPK signature', async () => {
    const signing = await generateSigningIdentity();
    const identityKey = await generateX25519PublicB64();
    const staleSpk = await generateX25519PublicB64();
    const freshSpk = await generateX25519PublicB64();
    const staleSignature = await signSpk(signing.privateKey, freshSpk);
    const freshSignature = await signSpk(signing.privateKey, freshSpk);

    supabaseMock.state.pubKeys = { identity_key: identityKey, signing_key: signing.publicB64 };
    supabaseMock.state.spkRows = [
      { spk_id: 1, public_key: staleSpk, signature: staleSignature, keys_epoch: 1 },
      { spk_id: 2, public_key: freshSpk, signature: freshSignature, keys_epoch: 2 },
    ];

    const bundle = await fetchPrekeyBundleForDevice('bob', 'B1');

    expect(bundle?.signedPrekeyId).toBe(2);
    expect(bundle?.keysEpoch).toBe(2);
    expect(supabaseMock.state.bundleCalls).toBe(2);
  });

  it('does not loop forever when the refetched SPK signature is still invalid', async () => {
    const signing = await generateSigningIdentity();
    const identityKey = await generateX25519PublicB64();
    const signedDifferentSpk = await generateX25519PublicB64();
    const invalidSignature = await signSpk(signing.privateKey, signedDifferentSpk);

    supabaseMock.state.pubKeys = { identity_key: identityKey, signing_key: signing.publicB64 };
    supabaseMock.state.spkRows = [
      { spk_id: 1, public_key: await generateX25519PublicB64(), signature: invalidSignature, keys_epoch: 1 },
      { spk_id: 2, public_key: await generateX25519PublicB64(), signature: invalidSignature, keys_epoch: 2 },
    ];

    await expect(fetchPrekeyBundleForDevice('bob', 'B1')).resolves.toBeNull();
    expect(supabaseMock.state.bundleCalls).toBe(2);
  });

  it('repairs local SPK/OPK loss, purges server prekeys, republishes, and new bundle verifies', async () => {
    const signing = await generateSigningIdentity();
    supabaseMock.state.pubKeys = {
      identity_key: await generateX25519PublicB64(),
      signing_key: signing.publicB64,
    };
    supabaseMock.state.serverDeviceSpk = { spk_id: 7, keys_epoch: 7 };
    supabaseMock.state.countOpks = 0;

    const repaired = await repairLocalDevicePrekeys('bob', 'B1', signing.privateKey);
    const bundle = await fetchPrekeyBundleForDevice('bob', 'B1', { forceRefresh: true });

    expect(repaired.message).toBe('appareil resynchronisé');
    expect(supabaseMock.state.updates).toContainEqual({
      table: 'device_signed_prekeys',
      payload: { is_active: false },
    });
    expect(supabaseMock.state.deletes).toContain('device_one_time_prekeys');
    expect(supabaseMock.state.insertedOpks).toHaveLength(50);
    expect(bundle?.signedPrekeyId).toBe(repaired.signedPrekeyId);
  });

  it('purges and republishes OPKs when server OPK ids lack local private halves', async () => {
    supabaseMock.state.countOpks = 5;
    supabaseMock.state.serverOpks = [{ opk_id: 100 }];

    await refillDeviceOneTimePrekeysIfNeeded('bob', 'B1');

    expect(supabaseMock.state.deletes).toContain('device_one_time_prekeys');
    expect(supabaseMock.state.insertedOpks).toHaveLength(50);
  });
});
