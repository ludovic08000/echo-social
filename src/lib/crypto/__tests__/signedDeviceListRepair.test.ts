import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardCrypto } from '../cryptoIntegrity';
import { bufferToBase64 } from '../utils';

const USER = '11111111-1111-4111-8111-111111111111';
const PRIMARY_DEVICE = 'primary-device-01';
const COMPANION_DEVICE = 'companion-device-01';
const COMPANION_PUBLIC_KEY = 'companion-x25519-public-key';

type SignatureRow = {
  user_id?: string;
  device_id: string;
  primary_device_id: string;
  primary_pub_b64: string;
  signature_b64: string;
  signed_at?: string;
  revoked_at?: string | null;
};

const db = vi.hoisted(() => ({
  devices: [] as Array<{ device_id: string; device_public_key: string; is_primary: boolean }>,
  signatures: [] as SignatureRow[],
  root: null as { primary_device_id: string; identity_pub_b64: string } | null,
  upserts: [] as SignatureRow[],
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

const identityMock = vi.hoisted(() => ({
  loadIdentityKeys: vi.fn(),
  exportPublicKeyRaw: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  loadIdentityKeys: identityMock.loadIdentityKeys,
  exportPublicKeyRaw: identityMock.exportPublicKeyRaw,
}));

function tableQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.is = self;
  chain.maybeSingle = async () => ({
    data: table === 'user_identity_roots' ? db.root : null,
    error: null,
  });
  chain.upsert = async (rows: SignatureRow | SignatureRow[]) => {
    db.upserts.push(...(Array.isArray(rows) ? rows : [rows]));
    return { error: null };
  };
  chain.then = (resolve: (value: unknown) => unknown) => {
    if (table === 'user_devices') {
      return Promise.resolve(resolve({ data: db.devices, error: null }));
    }
    if (table === 'user_device_signatures') {
      return Promise.resolve(resolve({
        data: db.signatures.filter((row) => !row.revoked_at),
        error: null,
      }));
    }
    return Promise.resolve(resolve({ data: null, error: null }));
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from: (table: string) => tableQuery(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      return { data: { ok: true, device_count: db.devices.length }, error: null };
    },
  },
}));

import {
  publishCompanionSignature,
  publishOwnSignedDeviceList,
  signCompanionDevice,
} from '../signedDeviceList';

let signingKeys: CryptoKeyPair;
let signingPublicB64: string;
let foreignPublicB64: string;

beforeAll(async () => {
  signingKeys = await hardCrypto.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  signingPublicB64 = bufferToBase64(
    await hardCrypto.exportKey('raw', signingKeys.publicKey) as ArrayBuffer,
  );
  const foreignKeys = await hardCrypto.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  foreignPublicB64 = bufferToBase64(
    await hardCrypto.exportKey('raw', foreignKeys.publicKey) as ArrayBuffer,
  );
});
beforeEach(() => {
  db.devices = [
    { device_id: PRIMARY_DEVICE, device_public_key: 'primary-x25519-public-key', is_primary: true },
    { device_id: COMPANION_DEVICE, device_public_key: COMPANION_PUBLIC_KEY, is_primary: false },
  ];
  db.signatures = [];
  db.root = { primary_device_id: PRIMARY_DEVICE, identity_pub_b64: signingPublicB64 };
  db.upserts = [];
  db.rpcCalls = [];
  identityMock.loadIdentityKeys.mockResolvedValue({
    signingPrivateKey: signingKeys.privateKey,
    signingPublicKey: signingKeys.publicKey,
  });
  identityMock.exportPublicKeyRaw.mockImplementation(
    async (key: CryptoKey) => hardCrypto.exportKey('raw', key),
  );
});

async function validCompanionSignature() {
  return signCompanionDevice({
    userId: USER,
    primaryDeviceId: PRIMARY_DEVICE,
    primaryEdPrivate: signingKeys.privateKey,
    primaryEdPublicB64: signingPublicB64,
    companionDeviceId: COMPANION_DEVICE,
    companionPublicKeyB64: COMPANION_PUBLIC_KEY,
  });
}

describe('signed device list repair', () => {
  it('keeps an existing companion only after its Ed25519 signature verifies', async () => {
    db.signatures = [await validCompanionSignature()];

    const result = await publishOwnSignedDeviceList({ signerDeviceId: PRIMARY_DEVICE });

    expect(result.ok).toBe(true);
    expect(db.upserts).toHaveLength(0);
  });

  it('re-signs a row whose signature is present but cryptographically invalid', async () => {
    db.signatures = [{
      device_id: COMPANION_DEVICE,
      primary_device_id: PRIMARY_DEVICE,
      primary_pub_b64: signingPublicB64,
      signature_b64: 'not-a-valid-ed25519-signature',
      revoked_at: null,
    }];

    const result = await publishOwnSignedDeviceList({ signerDeviceId: PRIMARY_DEVICE });

    expect(result.ok).toBe(true);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].signature_b64).not.toBe('not-a-valid-ed25519-signature');
  });

  it('re-signs a companion row attached to a stale root', async () => {
    db.signatures = [{
      device_id: COMPANION_DEVICE,
      primary_device_id: PRIMARY_DEVICE,
      primary_pub_b64: foreignPublicB64,
      signature_b64: 'stale-signature',
      revoked_at: null,
    }];

    const result = await publishOwnSignedDeviceList({ signerDeviceId: PRIMARY_DEVICE });

    expect(result.ok).toBe(true);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].primary_pub_b64).toBe(signingPublicB64);
  });

  it('fails explicitly when the local identity differs from the pinned account root', async () => {
    db.root = { primary_device_id: PRIMARY_DEVICE, identity_pub_b64: foreignPublicB64 };

    const result = await publishOwnSignedDeviceList({ signerDeviceId: PRIMARY_DEVICE });

    expect(result).toEqual({ ok: false, error: 'IDENTITY_ROOT_MISMATCH' });
    expect(db.upserts).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('also validates the account root when no companion exists yet', async () => {
    db.devices = [db.devices[0]];
    db.root = null;

    const result = await publishOwnSignedDeviceList({ signerDeviceId: PRIMARY_DEVICE });

    expect(result).toEqual({ ok: false, error: 'IDENTITY_ROOT_MISSING' });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('never republishes a per-device signature as the advisory list signature', async () => {
    const row = await validCompanionSignature();

    await publishCompanionSignature(row);

    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0].args).not.toHaveProperty('p_signature');
  });
});
