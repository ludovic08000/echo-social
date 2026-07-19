/**
 * Signed device list integration tests.
 *
 * The primary advertises two distinct public keys:
 * - X25519 devicePublicKey for Aegis transport
 * - Ed25519 primaryPubB64 as the companion-signature root
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardCrypto } from '../cryptoIntegrity';
import { bufferToBase64 } from '../utils';
import {
  signCompanionDevice,
  verifySignedDeviceList,
  type SignedDeviceEntry,
} from '../signedDeviceList';

const USER = '11111111-1111-4111-8111-111111111111';
const PRIMARY_DEV = 'primary-dev-1';
const COMP_DEV = 'companion-dev-1';

const rootState = vi.hoisted(() => ({
  primaryDeviceId: 'primary-dev-1',
  identityPubB64: '',
  missing: false,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'user_identity_roots') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => rootState.missing
              ? { data: null, error: null }
              : {
                  data: {
                    primary_device_id: rootState.primaryDeviceId,
                    identity_pub_b64: rootState.identityPubB64,
                  },
                  error: null,
                },
          }),
        }),
      };
    },
  },
}));

let primarySigningKp: CryptoKeyPair;
let primarySigningPubB64: string;
let primaryTransportPubB64: string;
let companionPubB64: string;

beforeAll(async () => {
  primarySigningKp = (await hardCrypto.generateKey(
    { name: 'Ed25519' } as any,
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  primarySigningPubB64 = bufferToBase64(
    await hardCrypto.exportKey('raw', primarySigningKp.publicKey) as ArrayBuffer,
  );

  const primaryTransportKp = (await hardCrypto.generateKey(
    { name: 'X25519' } as any,
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  primaryTransportPubB64 = bufferToBase64(
    await hardCrypto.exportKey('raw', primaryTransportKp.publicKey) as ArrayBuffer,
  );

  const companionKp = (await hardCrypto.generateKey(
    { name: 'X25519' } as any,
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  companionPubB64 = bufferToBase64(
    await hardCrypto.exportKey('raw', companionKp.publicKey) as ArrayBuffer,
  );
});

beforeEach(() => {
  rootState.primaryDeviceId = PRIMARY_DEV;
  rootState.identityPubB64 = primarySigningPubB64;
  rootState.missing = false;
});

function primaryEntry(overrides: Partial<SignedDeviceEntry> = {}): SignedDeviceEntry {
  return {
    deviceId: PRIMARY_DEV,
    devicePublicKey: primaryTransportPubB64,
    isPrimary: true,
    primaryDeviceId: null,
    primaryPubB64: primarySigningPubB64,
    signatureB64: null,
    signedAt: null,
    ...overrides,
  };
}

async function signedCompanion(): Promise<SignedDeviceEntry> {
  const signature = await signCompanionDevice({
    userId: USER,
    primaryDeviceId: PRIMARY_DEV,
    primaryEdPrivate: primarySigningKp.privateKey,
    primaryEdPublicB64: primarySigningPubB64,
    companionDeviceId: COMP_DEV,
    companionPublicKeyB64: companionPubB64,
  });
  return {
    deviceId: COMP_DEV,
    devicePublicKey: companionPubB64,
    isPrimary: false,
    primaryDeviceId: signature.primary_device_id,
    primaryPubB64: signature.primary_pub_b64,
    signatureB64: signature.signature_b64,
    signedAt: signature.signed_at,
  };
}

describe('signed device list', () => {
  it('accepts a companion signed by the unique canonical Ed25519 root', async () => {
    const result = await verifySignedDeviceList(USER, [primaryEntry(), await signedCompanion()]);
    expect(result.find((entry) => entry.deviceId === PRIMARY_DEV)?.ok).toBe(true);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(true);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('VALID');
  });

  it('keeps the signature valid when PostgreSQL reformats signed_at', async () => {
    const companion = await signedCompanion();
    const postgresTimestamp = companion.signedAt!.replace('Z', '+00:00');
    const result = await verifySignedDeviceList(USER, [
      primaryEntry(),
      { ...companion, signedAt: postgresTimestamp },
    ]);

    expect(result.find((entry) => entry.deviceId === COMP_DEV)).toMatchObject({
      ok: true,
      reason: 'VALID',
    });
  });

  it('rejects the whole list when there is no primary', async () => {
    const companion = await signedCompanion();
    const result = await verifySignedDeviceList(USER, [companion]);
    expect(result).toEqual([{ deviceId: COMP_DEV, ok: false, reason: 'PRIMARY_COUNT_INVALID' }]);
  });

  it('rejects the whole list when there are two primaries', async () => {
    const secondPrimary = primaryEntry({ deviceId: 'primary-dev-2' });
    const result = await verifySignedDeviceList(USER, [primaryEntry(), secondPrimary]);
    expect(result.every((entry) => !entry.ok && entry.reason === 'PRIMARY_COUNT_INVALID')).toBe(true);
  });

  it('rejects the whole list when the canonical root is absent', async () => {
    rootState.missing = true;
    const result = await verifySignedDeviceList(USER, [primaryEntry(), await signedCompanion()]);
    expect(result.every((entry) => !entry.ok && entry.reason === 'PRIMARY_ROOT_MISSING')).toBe(true);
  });

  it('rejects the whole list when the primary contradicts the canonical root', async () => {
    rootState.primaryDeviceId = 'other-primary-device';
    const result = await verifySignedDeviceList(USER, [primaryEntry(), await signedCompanion()]);
    expect(result.every((entry) => !entry.ok && entry.reason === 'PRIMARY_PUB_MISMATCH')).toBe(true);
  });

  it('rejects a primary row that self-links instead of advertising only the root', async () => {
    const result = await verifySignedDeviceList(USER, [
      primaryEntry({ primaryDeviceId: PRIMARY_DEV }),
      await signedCompanion(),
    ]);
    expect(result.every((entry) => !entry.ok && entry.reason === 'PRIMARY_PUB_MISMATCH')).toBe(true);
  });

  it('rejects a companion with no signature', async () => {
    const list: SignedDeviceEntry[] = [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: null,
        primaryPubB64: null,
        signatureB64: null,
        signedAt: null,
      },
    ];

    const result = await verifySignedDeviceList(USER, list);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('NO_SIGNATURE');
  });

  it('rejects a companion with a modified signature', async () => {
    const companion = await signedCompanion();
    const badSignature = companion.signatureB64!.startsWith('A')
      ? `B${companion.signatureB64!.slice(1)}`
      : `A${companion.signatureB64!.slice(1)}`;

    const result = await verifySignedDeviceList(USER, [
      primaryEntry(),
      { ...companion, signatureB64: badSignature },
    ]);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('BAD_SIGNATURE');
  });

  it('rejects a ghost primary Ed25519 key', async () => {
    const attacker = (await hardCrypto.generateKey(
      { name: 'Ed25519' } as any,
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const attackerPub = bufferToBase64(
      await hardCrypto.exportKey('raw', attacker.publicKey) as ArrayBuffer,
    );
    const signature = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: attacker.privateKey,
      primaryEdPublicB64: attackerPub,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });

    const result = await verifySignedDeviceList(USER, [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: PRIMARY_DEV,
        primaryPubB64: attackerPub,
        signatureB64: signature.signature_b64,
        signedAt: signature.signed_at,
      },
    ]);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('PRIMARY_PUB_MISMATCH');
  });

  it('rejects a swapped companion X25519 key', async () => {
    const companion = await signedCompanion();
    const fake = (await hardCrypto.generateKey(
      { name: 'X25519' } as any,
      true,
      ['deriveBits'],
    )) as CryptoKeyPair;
    const fakePub = bufferToBase64(
      await hardCrypto.exportKey('raw', fake.publicKey) as ArrayBuffer,
    );

    const result = await verifySignedDeviceList(USER, [
      primaryEntry(),
      { ...companion, devicePublicKey: fakePub },
    ]);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('BAD_SIGNATURE');
  });
});
