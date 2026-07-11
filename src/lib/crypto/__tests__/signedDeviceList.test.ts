/**
 * Signed device list integration test.
 *
 * The primary advertises two distinct public keys:
 * - X25519 devicePublicKey for Sesame transport
 * - Ed25519 primaryPubB64 as the companion-signature root
 */
import { describe, it, expect, beforeAll } from 'vitest';
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

function primaryEntry(): SignedDeviceEntry {
  return {
    deviceId: PRIMARY_DEV,
    devicePublicKey: primaryTransportPubB64,
    isPrimary: true,
    primaryDeviceId: PRIMARY_DEV,
    primaryPubB64: primarySigningPubB64,
    signatureB64: null,
    signedAt: null,
  };
}

describe('signed device list', () => {
  it('accepts a companion signed by the primary Ed25519 root', async () => {
    const signature = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: primarySigningKp.privateKey,
      primaryEdPublicB64: primarySigningPubB64,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });
    const list: SignedDeviceEntry[] = [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: signature.primary_device_id,
        primaryPubB64: signature.primary_pub_b64,
        signatureB64: signature.signature_b64,
        signedAt: signature.signed_at,
      },
    ];

    const result = await verifySignedDeviceList(USER, list);
    expect(result.find((entry) => entry.deviceId === PRIMARY_DEV)?.ok).toBe(true);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(true);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('VALID');
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
    const signature = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: primarySigningKp.privateKey,
      primaryEdPublicB64: primarySigningPubB64,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });
    const badSignature = signature.signature_b64.startsWith('A')
      ? `B${signature.signature_b64.slice(1)}`
      : `A${signature.signature_b64.slice(1)}`;

    const result = await verifySignedDeviceList(USER, [
      primaryEntry(),
      {
        deviceId: COMP_DEV,
        devicePublicKey: companionPubB64,
        isPrimary: false,
        primaryDeviceId: PRIMARY_DEV,
        primaryPubB64: primarySigningPubB64,
        signatureB64: badSignature,
        signedAt: signature.signed_at,
      },
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
    const signature = await signCompanionDevice({
      userId: USER,
      primaryDeviceId: PRIMARY_DEV,
      primaryEdPrivate: primarySigningKp.privateKey,
      primaryEdPublicB64: primarySigningPubB64,
      companionDeviceId: COMP_DEV,
      companionPublicKeyB64: companionPubB64,
    });
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
      {
        deviceId: COMP_DEV,
        devicePublicKey: fakePub,
        isPrimary: false,
        primaryDeviceId: PRIMARY_DEV,
        primaryPubB64: primarySigningPubB64,
        signatureB64: signature.signature_b64,
        signedAt: signature.signed_at,
      },
    ]);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.ok).toBe(false);
    expect(result.find((entry) => entry.deviceId === COMP_DEV)?.reason).toBe('BAD_SIGNATURE');
  });
});
