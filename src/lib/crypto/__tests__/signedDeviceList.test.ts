/**
 * L4 — Signed device list integration test
 *
 * Verifies that a companion device's X25519 transport key signed by the
 * account Ed25519 signing root is accepted, while every tampering vector is
 * rejected.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { hardCrypto } from '../cryptoIntegrity';
import { bufferToBase64 } from '../utils';
import {
  signCompanionDevice,
  verifySignedDeviceList,
  type SignedDeviceEntry,
} from '../signedDeviceList';

const mocks = vi.hoisted(() => ({
  accountSigningKey: '',
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'user_public_keys') throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { signing_key: mocks.accountSigningKey },
                error: null,
              }),
            }),
          }),
        }),
      };
    },
  },
}));

const USER = '11111111-1111-4111-8111-111111111111';
const PRIMARY_DEV = 'primary-dev-1';
const COMP_DEV = 'companion-dev-1';

let primaryKp: CryptoKeyPair;
let primaryPubB64: string;
let primaryDeviceKxPubB64: string;
let companionPubB64: string;

beforeAll(async () => {
  primaryKp = (await hardCrypto.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = await hardCrypto.exportKey('raw', primaryKp.publicKey);
  primaryPubB64 = bufferToBase64(pub as ArrayBuffer);
  mocks.accountSigningKey = primaryPubB64;

  const primaryDeviceKx = (await hardCrypto.generateKey({ name: 'X25519' } as any, true, ['deriveBits'])) as CryptoKeyPair;
  primaryDeviceKxPubB64 = bufferToBase64(
    await hardCrypto.exportKey('raw', primaryDeviceKx.publicKey) as ArrayBuffer,
  );

  const compKp = (await hardCrypto.generateKey({ name: 'X25519' } as any, true, ['deriveBits'])) as CryptoKeyPair;
  const compPub = await hardCrypto.exportKey('raw', compKp.publicKey);
  companionPubB64 = bufferToBase64(compPub as ArrayBuffer);
});

function primaryEntry(): SignedDeviceEntry {
  return {
    deviceId: PRIMARY_DEV,
    devicePublicKey: primaryDeviceKxPubB64,
    isPrimary: true,
    primaryDeviceId: null,
    primaryPubB64: null,
    signatureB64: null,
    signedAt: null,
  };
}

describe('L4 — signed device list', () => {
  it('accepts a companion signed by the account signing root', async () => {
    const sig = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: primaryKp.privateKey,
      primaryEdPublicB64: primaryPubB64,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });
    const list: SignedDeviceEntry[] = [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: sig.primary_device_id,
        primaryPubB64: sig.primary_pub_b64,
        signatureB64: sig.signature_b64,
        signedAt: sig.signed_at,
      },
    ];
    const r = await verifySignedDeviceList(USER, list);
    expect(r.find(x => x.deviceId === PRIMARY_DEV)?.ok).toBe(true);
    expect(r.find(x => x.deviceId === COMP_DEV)?.ok).toBe(true);
    expect(r.find(x => x.deviceId === COMP_DEV)?.reason).toBe('VALID');
  });

  it('rejects a companion with NO signature', async () => {
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
    const r = await verifySignedDeviceList(USER, list);
    expect(r.find(x => x.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(r.find(x => x.deviceId === COMP_DEV)?.reason).toBe('NO_SIGNATURE');
  });

  it('rejects a companion with a flipped signature byte', async () => {
    const sig = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: primaryKp.privateKey,
      primaryEdPublicB64: primaryPubB64,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });
    const sigBad = sig.signature_b64.startsWith('A')
      ? 'B' + sig.signature_b64.slice(1)
      : 'A' + sig.signature_b64.slice(1);

    const list: SignedDeviceEntry[] = [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: PRIMARY_DEV,
        primaryPubB64: primaryPubB64,
        signatureB64: sigBad,
        signedAt: sig.signed_at,
      },
    ];
    const r = await verifySignedDeviceList(USER, list);
    expect(r.find(x => x.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(r.find(x => x.deviceId === COMP_DEV)?.reason).toBe('BAD_SIGNATURE');
  });

  it('rejects a ghost signing-root attack', async () => {
    const attackerKp = (await hardCrypto.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify'])) as CryptoKeyPair;
    const attackerPub = bufferToBase64(await hardCrypto.exportKey('raw', attackerKp.publicKey) as ArrayBuffer);
    const sig = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: attackerKp.privateKey,
      primaryEdPublicB64: attackerPub,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });

    const list: SignedDeviceEntry[] = [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: PRIMARY_DEV,
        primaryPubB64: attackerPub,
        signatureB64: sig.signature_b64,
        signedAt: sig.signed_at,
      },
    ];
    const r = await verifySignedDeviceList(USER, list);
    expect(r.find(x => x.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(r.find(x => x.deviceId === COMP_DEV)?.reason).toBe('PRIMARY_PUB_MISMATCH');
  });

  it('rejects a tampered companion transport key', async () => {
    const sig = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: primaryKp.privateKey,
      primaryEdPublicB64: primaryPubB64,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });
    const fakeKp = (await hardCrypto.generateKey({ name: 'X25519' } as any, true, ['deriveBits'])) as CryptoKeyPair;
    const fakePub = bufferToBase64(await hardCrypto.exportKey('raw', fakeKp.publicKey) as ArrayBuffer);

    const list: SignedDeviceEntry[] = [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: fakePub,
        isPrimary: false,
        primaryDeviceId: PRIMARY_DEV,
        primaryPubB64: primaryPubB64,
        signatureB64: sig.signature_b64,
        signedAt: sig.signed_at,
      },
    ];
    const r = await verifySignedDeviceList(USER, list);
    expect(r.find(x => x.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(r.find(x => x.deviceId === COMP_DEV)?.reason).toBe('BAD_SIGNATURE');
  });
});
