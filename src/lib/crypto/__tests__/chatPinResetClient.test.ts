import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadDeviceIdentity: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: (...args: unknown[]) => mocks.loadDeviceIdentity(...args),
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: { sign: (...args: unknown[]) => mocks.sign(...args) },
  hardGlobals: {
    atob: globalThis.atob.bind(globalThis),
    btoa: globalThis.btoa.bind(globalThis),
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  },
}));

import {
  authorizeChatPinReset,
  canonicalChatPinResetDeviceProof,
  commitChatPinReset,
  requestChatPinReset,
} from '@/lib/crypto/chatPinResetClient';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHALLENGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_ID = `dev_${'c'.repeat(32)}`;
const TOKEN = globalThis.btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe('secure chat PIN reset client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDeviceIdentity.mockResolvedValue({
      publicB64: 'device-public-key',
      privateKey: { type: 'private' },
    });
    mocks.sign.mockResolvedValue(new Uint8Array(64).fill(9).buffer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests an email challenge without sending a PIN or recipient address', async () => {
    mocks.invoke.mockResolvedValue({
      data: {
        ok: true,
        challengeId: CHALLENGE_ID,
        expiresAt: '2026-09-23T22:00:00.000Z',
      },
      error: null,
    });

    await expect(requestChatPinReset()).resolves.toEqual({
      ok: true,
      challengeId: CHALLENGE_ID,
      expiresAt: '2026-09-23T22:00:00.000Z',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('verify-chat-pin', {
      body: { action: 'request-reset' },
    });
  });

  it('signs the exact server-verifiable challenge with the current device key', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_795_000_000_000);
    mocks.invoke.mockResolvedValue({
      data: {
        ok: true,
        challengeId: CHALLENGE_ID,
        authorizationToken: TOKEN,
        authorizationExpiresAt: '2026-09-23T22:05:00.000Z',
        generation: 4,
      },
      error: null,
    });

    const result = await authorizeChatPinReset({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      challengeId: CHALLENGE_ID,
      code: '123456',
    });

    expect(result).toEqual({
      ok: true,
      challengeId: CHALLENGE_ID,
      authorizationToken: TOKEN,
      authorizationExpiresAt: '2026-09-23T22:05:00.000Z',
      generation: 4,
    });
    expect(mocks.loadDeviceIdentity).toHaveBeenCalledWith(USER_ID, DEVICE_ID);
    const signedBytes = mocks.sign.mock.calls[0]?.[2] as ArrayBuffer;
    expect(new TextDecoder().decode(signedBytes)).toBe(
      `forsure-aegis-pin-reset|${CHALLENGE_ID}|${USER_ID}|${DEVICE_ID}|1795000000000`,
    );
    const requestBody = mocks.invoke.mock.calls[0]?.[1]?.body;
    expect(requestBody).toMatchObject({
      action: 'authorize-reset',
      challengeId: CHALLENGE_ID,
      code: '123456',
      deviceId: DEVICE_ID,
      deviceProofIssuedAtMs: 1_795_000_000_000,
    });
    expect(requestBody).not.toHaveProperty('pin');
    expect(requestBody).not.toHaveProperty('authorizationToken');
  });

  it('commits only the Master-Key-encrypted envelope with generation control', async () => {
    mocks.invoke.mockResolvedValue({
      data: { ok: true, generation: 5 },
      error: null,
    });

    await expect(commitChatPinReset({
      challengeId: CHALLENGE_ID,
      deviceId: DEVICE_ID,
      authorizationToken: TOKEN,
      expectedGeneration: 4,
      envelope: {
        version: 1,
        ciphertext: globalThis.btoa(String.fromCharCode(...new Uint8Array(64).fill(3))),
        iv: globalThis.btoa(String.fromCharCode(...new Uint8Array(12).fill(5))),
      },
    })).resolves.toEqual({ ok: true, generation: 5 });

    const requestBody = mocks.invoke.mock.calls[0]?.[1]?.body;
    expect(requestBody).toMatchObject({
      action: 'commit-reset',
      expectedGeneration: 4,
      version: 1,
    });
    expect(requestBody).not.toHaveProperty('pin');
    expect(requestBody).not.toHaveProperty('salt');
    expect(requestBody).not.toHaveProperty('wrappedBlob');
  });

  it('uses the same canonical proof format enforced by the SQL transaction', () => {
    expect(canonicalChatPinResetDeviceProof({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      issuedAtMs: 1_795_000_000_000,
    })).toBe(
      `forsure-aegis-pin-reset|${CHALLENGE_ID}|${USER_ID}|${DEVICE_ID}|1795000000000`,
    );
  });

  it('fails closed when the current Aegis device key is unavailable', async () => {
    mocks.loadDeviceIdentity.mockResolvedValue(null);

    await expect(authorizeChatPinReset({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      challengeId: CHALLENGE_ID,
      code: '123456',
    })).resolves.toMatchObject({
      ok: false,
      code: 'PIN_RESET_DEVICE_KEY_UNAVAILABLE',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
