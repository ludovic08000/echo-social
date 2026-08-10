import { beforeEach, describe, expect, it, vi } from 'vitest';

const isIosWebRuntimeMock = vi.fn(() => true);
const getSessionMock = vi.fn();
const setCurrentDeviceIdMock = vi.fn();
const setCurrentDeviceUserScopeMock = vi.fn();
const prepareKeysMock = vi.fn();
const restoreVaultMock = vi.fn();
const recordRpcErrorMock = vi.fn();
const recordPasskeyEventMock = vi.fn();

vi.mock('@/platforms/ios/iosRuntime', () => ({
  isIosWebRuntime: () => isIosWebRuntimeMock(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

vi.mock('@/platforms/ios/iosRpcErrorLog', () => ({
  recordIosRpcError: (...args: unknown[]) => recordRpcErrorMock(...args),
}));

vi.mock('@/platforms/ios/iosPasskeyState', () => ({
  recordIosPasskeyEvent: (...args: unknown[]) => recordPasskeyEventMock(...args),
}));

vi.mock('@/platforms/shared/webauthnBrowser', () => ({
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
  requireBrowserWebAuthn: vi.fn(() => undefined),
  webauthnFromBase64Url: vi.fn(() => new Uint8Array([1, 2, 3]).buffer),
  webauthnToBase64Url: vi.fn(() => 'credential_1234567890'),
  webauthnRegistrationProofPayload: vi.fn(() => 'payload'),
  webauthnSha256B64Url: vi.fn(async () => 'hash'),
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: { sign: vi.fn(async () => new Uint8Array(64).buffer) },
}));

vi.mock('@/lib/crypto/utils', () => ({
  bufferToBase64: vi.fn(() => 'signature'),
  encodeString: vi.fn(() => new Uint8Array()),
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: vi.fn(async () => null),
}));

vi.mock('@/lib/crypto/webDeviceKeyVault', () => ({
  captureEncryptedWebDeviceVault: vi.fn(),
  restoreEncryptedWebDeviceVault: (...args: unknown[]) => restoreVaultMock(...args),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  setCurrentDeviceId: (...args: unknown[]) => setCurrentDeviceIdMock(...args),
  setCurrentDeviceUserScope: (...args: unknown[]) => setCurrentDeviceUserScopeMock(...args),
}));

vi.mock('@/lib/api/deviceApi', () => ({
  deviceApi: { prepareKeys: (...args: unknown[]) => prepareKeysMock(...args) },
}));

import {
  getIosPasskeyStatus,
  recoverIosDeviceWithPasskey,
} from '@/platforms/ios/iosPasskeyProvider';

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Forbidden',
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe('iosPasskeyProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isIosWebRuntimeMock.mockReturnValue(true);
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'token-ios' } },
      error: null,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  it('reste fail-closed hors iOS sans appeler le réseau', async () => {
    isIosWebRuntimeMock.mockReturnValue(false);
    expect(await getIosPasskeyStatus('dev_' + 'a'.repeat(32))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lit le status via /api/webauthn-device avec Bearer', async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      data: { ok: true, registered: true },
      error: null,
    }));

    expect(await getIosPasskeyStatus('dev_' + 'b'.repeat(32))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/webauthn-device');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token-ios');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: 'status',
      deviceId: 'dev_' + 'b'.repeat(32),
    });
  });

  it('ne génère ni n’adopte de DeviceID si la vérification serveur recovery échoue', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({
        data: {
          ok: true,
          challengeId: '11111111-1111-1111-1111-111111111111',
          challenge: 'challenge_1234567890',
          rpId: 'example.com',
          origin: 'https://example.com',
          publicKey: {
            challenge: 'challenge_1234567890',
            rpId: 'example.com',
            timeout: 60000,
            userVerification: 'required',
            allowCredentials: [{ type: 'public-key', id: 'credential_1234567890', transports: [] }],
          },
        },
        error: null,
      }))
      .mockResolvedValueOnce(response({
        data: null,
        error: { code: 'WEBAUTHN_ASSERTION_SIGNATURE_INVALID', message: 'invalid signature' },
      }, false, 403));

    vi.stubGlobal('navigator', {
      credentials: {
        get: vi.fn(async () => ({
          rawId: new Uint8Array([1, 2, 3]).buffer,
          response: {
            clientDataJSON: new Uint8Array([1]).buffer,
            authenticatorData: new Uint8Array(37).buffer,
            signature: new Uint8Array([2]).buffer,
          },
        })),
      },
    });

    await expect(recoverIosDeviceWithPasskey('user-1')).rejects.toThrow('WEBAUTHN_ASSERTION_SIGNATURE_INVALID');
    expect(setCurrentDeviceIdMock).not.toHaveBeenCalled();
    expect(setCurrentDeviceUserScopeMock).not.toHaveBeenCalled();
    expect(restoreVaultMock).not.toHaveBeenCalled();
    expect(prepareKeysMock).not.toHaveBeenCalled();
  });
});
