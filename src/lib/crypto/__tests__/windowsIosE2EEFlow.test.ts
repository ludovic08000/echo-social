/**
 * Cross-platform Aegis flow contract.
 *
 * This suite deliberately uses the production device Double Ratchet rather
 * than the mocked ratchet used by the routing-only cross-platform tests. The
 * platform labels model the stable Windows device and the iOS web device; the
 * wire crypto is platform-agnostic by design.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AEGIS_RATCHET_PREFIX,
  clearAllDeviceSessions,
  establishDeviceSession,
  listKnownSessionIds,
  ratchetDecrypt,
  ratchetEncrypt,
} from '@/lib/crypto/deviceRatchet';

const WINDOWS = {
  userId: 'user-windows',
  deviceId: 'dev_windows_chrome_stable',
  identityKey: 'ik-windows-device',
};

const IOS = {
  userId: 'user-ios',
  deviceId: 'dev_ios_safari_stable',
  identityKey: 'ik-ios-device',
};

function makeSharedSecret(seed: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed * 37 + index * 11) & 0xff;
  }
  return bytes.buffer;
}

async function generateX25519(): Promise<{ pubB64: string; privJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'X25519' } as Algorithm,
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    pubB64: btoa(String.fromCharCode(...new Uint8Array(raw))),
    privJwk: jwk,
  };
}

async function bootstrapWindowsToIos(seed = 91): Promise<string> {
  const sharedSecret = makeSharedSecret(seed);
  const iosSignedPrekey = await generateX25519();

  const sessionId = await establishDeviceSession(
    WINDOWS.userId,
    WINDOWS.deviceId,
    IOS.userId,
    IOS.deviceId,
    sharedSecret,
    undefined,
    {
      isInitiator: true,
      peerInitialDhPubB64: iosSignedPrekey.pubB64,
      peerSpkId: 7001,
      selfIkPubB64: WINDOWS.identityKey,
      peerIkPubB64: IOS.identityKey,
    },
  );

  await establishDeviceSession(
    IOS.userId,
    IOS.deviceId,
    WINDOWS.userId,
    WINDOWS.deviceId,
    sharedSecret,
    sessionId,
    {
      isInitiator: false,
      peerSpkId: 7001,
      selfInitialDhPrivJwk: iosSignedPrekey.privJwk,
      selfInitialDhPubB64: iosSignedPrekey.pubB64,
      selfIkPubB64: IOS.identityKey,
      peerIkPubB64: WINDOWS.identityKey,
    },
  );

  return sessionId;
}

async function expectEncryptedRoundTrip(args: {
  from: typeof WINDOWS;
  to: typeof IOS;
  plaintext: string;
}): Promise<string> {
  const encrypted = await ratchetEncrypt(
    args.from.userId,
    args.from.deviceId,
    args.to.userId,
    args.to.deviceId,
    args.plaintext,
  );

  expect(encrypted).not.toBeNull();
  expect(encrypted!.startsWith(AEGIS_RATCHET_PREFIX)).toBe(true);
  expect(encrypted).not.toContain(args.plaintext);

  const decrypted = await ratchetDecrypt(
    args.to.userId,
    args.to.deviceId,
    encrypted!,
  );
  expect(decrypted).toBe(args.plaintext);
  return encrypted!;
}

describe('Aegis Windows <-> iOS real E2EE flow', () => {
  beforeEach(async () => {
    await clearAllDeviceSessions();
  });

  it('encrypts on Windows and decrypts on iOS with the production Double Ratchet', async () => {
    await bootstrapWindowsToIos();
    await expectEncryptedRoundTrip({
      from: WINDOWS,
      to: IOS,
      plaintext: 'windows-to-ios:first-message',
    });
  });

  it('decrypts the iOS reply on Windows and keeps one established session', async () => {
    const sessionId = await bootstrapWindowsToIos(92);

    await expectEncryptedRoundTrip({
      from: WINDOWS,
      to: IOS,
      plaintext: 'windows-to-ios:bootstrap-message',
    });
    await expectEncryptedRoundTrip({
      from: IOS,
      to: WINDOWS,
      plaintext: 'ios-to-windows:reply',
    });

    const windowsSessions = await listKnownSessionIds(WINDOWS.userId, WINDOWS.deviceId);
    const iosSessions = await listKnownSessionIds(IOS.userId, IOS.deviceId);
    expect(windowsSessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(iosSessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
  });

  it('advances the same ratchet across multiple messages without a new bootstrap', async () => {
    const sessionId = await bootstrapWindowsToIos(93);

    const c0 = await expectEncryptedRoundTrip({
      from: WINDOWS,
      to: IOS,
      plaintext: 'windows-to-ios:0',
    });
    const c1 = await expectEncryptedRoundTrip({
      from: WINDOWS,
      to: IOS,
      plaintext: 'windows-to-ios:1',
    });
    const reply = await expectEncryptedRoundTrip({
      from: IOS,
      to: WINDOWS,
      plaintext: 'ios-to-windows:0',
    });
    const c2 = await expectEncryptedRoundTrip({
      from: WINDOWS,
      to: IOS,
      plaintext: 'windows-to-ios:2',
    });

    expect(new Set([c0, c1, reply, c2]).size).toBe(4);

    const windowsSessions = await listKnownSessionIds(WINDOWS.userId, WINDOWS.deviceId);
    const iosSessions = await listKnownSessionIds(IOS.userId, IOS.deviceId);
    expect(windowsSessions).toHaveLength(1);
    expect(iosSessions).toHaveLength(1);
    expect(windowsSessions[0]?.sessionId).toBe(sessionId);
    expect(iosSessions[0]?.sessionId).toBe(sessionId);
  });

  it('fails closed when no Windows/iOS device session exists', async () => {
    await expect(
      ratchetEncrypt(
        WINDOWS.userId,
        WINDOWS.deviceId,
        IOS.userId,
        IOS.deviceId,
        'must-never-leave-in-plaintext',
      ),
    ).resolves.toBeNull();

    await expect(
      ratchetDecrypt(IOS.userId, IOS.deviceId, 'must-never-be-accepted-as-plaintext'),
    ).resolves.toBeNull();
  });

  it('rejects a replayed Windows ciphertext on iOS', async () => {
    await bootstrapWindowsToIos(94);
    const encrypted = await ratchetEncrypt(
      WINDOWS.userId,
      WINDOWS.deviceId,
      IOS.userId,
      IOS.deviceId,
      'windows-to-ios:single-use',
    );

    expect(encrypted).not.toBeNull();
    await expect(ratchetDecrypt(IOS.userId, IOS.deviceId, encrypted!))
      .resolves.toBe('windows-to-ios:single-use');
    await expect(ratchetDecrypt(IOS.userId, IOS.deviceId, encrypted!))
      .resolves.toBeNull();
  });
});
