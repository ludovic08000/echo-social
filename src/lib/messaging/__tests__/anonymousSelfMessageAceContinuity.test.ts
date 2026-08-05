import { beforeEach, describe, expect, it, vi } from 'vitest';

type DeviceState = {
  deviceId: string;
  signingFingerprint: string;
  kxFingerprint: string;
  signedPrekeyId: number;
  signedPrekeyFingerprint: string;
};

type RouteTarget = {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
};

const runtime = vi.hoisted(() => ({
  anonymousUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  senderDeviceId: 'dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  receiverDeviceId: 'dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  anchorAvailable: true,
  sealedNativeState: null as DeviceState | null,
  webCacheState: null as DeviceState | null,
  deviceGenerationCount: 0,
  encryptionCount: 0,
  routeVersion: 'route-anonymous-self-v1',
  routeTargets: [] as RouteTarget[],
  invalidations: 0,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => runtime.senderDeviceId,
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  isDevicePrekeyBundleError: () => false,
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  AEGIS_RATCHET_PREFIX: 'aegis1.ratchet',
  ratchetEncrypt: async (
    _senderUserId: string,
    _senderDeviceId: string,
    _recipientUserId: string,
    recipientDeviceId: string,
  ) => {
    runtime.encryptionCount += 1;
    return `aegis1.ratchet:cipher-${runtime.encryptionCount}-${recipientDeviceId}`;
  },
  ratchetDecryptWithSession: vi.fn(),
}));

vi.mock('@/lib/crypto/aegisDeviceWire', () => ({
  parseAegisRatchetPayload: () => null,
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoException: vi.fn(),
  logCryptoError: vi.fn(),
}));

vi.mock('@/lib/crypto/peerKeyCache', () => ({
  getCachedAuthUserId: async () => runtime.anonymousUserId,
}));

vi.mock('@/lib/messaging/fanoutRouteCache', () => ({
  resolveFanoutRouteSnapshot: async () => ({
    version: runtime.routeVersion,
    targets: runtime.routeTargets,
  }),
  invalidateFanoutRoute: () => {
    runtime.invalidations += 1;
  },
}));

vi.mock('@/lib/messaging/fanoutSessionTransaction', () => ({
  captureFanoutSessionBeforeMutation: async () => undefined,
  rollbackFanoutSessionTarget: async () => true,
}));

vi.mock('@/lib/messaging/repeatablePreKeyEnvelope', () => ({
  acknowledgeInitiatingSessionFromRatchetPayload: vi.fn(),
  createRepeatablePreKeyEnvelope: vi.fn(),
  isRepeatablePreKeyEnvelope: () => false,
  prepareInitiatingSessionForSend: async () => 'ready',
  restartExpiredInitiatingSession: async () => undefined,
  unwrapRepeatablePreKeyEnvelope: vi.fn(),
  wrapRatchetForInitiatingSession: async ({ ratchetPayload }: { ratchetPayload: string }) =>
    `aegis1.init.v1:${ratchetPayload}`,
}));

vi.mock('@/lib/crypto/deviceSessionQueue', () => ({
  runDeviceSessionJob: async (
    _kind: string,
    _key: string,
    job: () => Promise<unknown>,
  ) => job(),
}));

vi.mock('@/lib/messaging/e2eeTrace', () => ({
  traceE2EE: vi.fn(),
}));

import { buildFanoutCopies } from '@/lib/messaging/multiDeviceFanout';

function cloneDeviceState(state: DeviceState): DeviceState {
  return { ...state };
}

/**
 * Browser integration harness for the native ACE contract.
 *
 * `sealedNativeState` models the Keychain value sealed by the non-exportable
 * Secure Enclave anchor. `webCacheState` models purgeable WKWebView/IndexedDB
 * state. The real Swift sealing primitive is covered separately by the native
 * contract tests; this test composes continuity with the real fanout builder.
 */
function restoreOrEnrollSenderDevice(): DeviceState {
  if (runtime.webCacheState) return cloneDeviceState(runtime.webCacheState);

  if (runtime.sealedNativeState) {
    if (!runtime.anchorAvailable) {
      throw new Error('E2EE_ENCLAVE_ANCHOR_MISSING');
    }
    runtime.webCacheState = cloneDeviceState(runtime.sealedNativeState);
    return cloneDeviceState(runtime.webCacheState);
  }

  runtime.deviceGenerationCount += 1;
  const generation = runtime.deviceGenerationCount;
  const created: DeviceState = {
    deviceId: runtime.senderDeviceId,
    signingFingerprint: `ed25519-device-${generation}`,
    kxFingerprint: `x25519-device-${generation}`,
    signedPrekeyId: 7000 + generation,
    signedPrekeyFingerprint: `spk-device-${generation}`,
  };
  runtime.sealedNativeState = cloneDeviceState(created);
  runtime.webCacheState = cloneDeviceState(created);
  return created;
}

async function sendAnonymousSelfMessage(messageId: string, plaintext: string) {
  const senderState = restoreOrEnrollSenderDevice();
  const fanout = await buildFanoutCopies({
    messageId,
    conversationId: 'conversation-anonymous-self',
    senderUserId: runtime.anonymousUserId,
    plaintext,
  });
  return { senderState, fanout };
}

describe('anonymous self-message with ACE continuity', () => {
  beforeEach(() => {
    runtime.anchorAvailable = true;
    runtime.sealedNativeState = null;
    runtime.webCacheState = null;
    runtime.deviceGenerationCount = 0;
    runtime.encryptionCount = 0;
    runtime.invalidations = 0;
    runtime.routeTargets = [{
      userId: runtime.anonymousUserId,
      deviceId: runtime.receiverDeviceId,
      devicePublicKey: 'receiver-device-x25519-public-key',
    }];
  });

  it('sends to another device of the same anonymous user before and after a web-cache purge without rotating device keys', async () => {
    const markerBefore = 'anonymous-self-before-purge';
    const first = await sendAnonymousSelfMessage('message-before-purge', markerBefore);
    const identityBefore = cloneDeviceState(first.senderState);

    expect(first.fanout.hasTargets).toBe(true);
    expect(first.fanout.routeVersion).toBe(runtime.routeVersion);
    expect(first.fanout.rows).toHaveLength(1);
    expect(first.fanout.rows[0]).toMatchObject({
      message_id: 'message-before-purge',
      sender_user_id: runtime.anonymousUserId,
      sender_device_id: runtime.senderDeviceId,
      recipient_user_id: runtime.anonymousUserId,
      recipient_device_id: runtime.receiverDeviceId,
    });
    expect(first.fanout.rows[0].encrypted_body).not.toContain(markerBefore);

    // Simulates clearing IndexedDB, Cache Storage and WKWebView website data.
    // The ACE/Keychain record deliberately remains outside that purge domain.
    runtime.webCacheState = null;

    const markerAfter = 'anonymous-self-after-purge';
    const second = await sendAnonymousSelfMessage('message-after-purge', markerAfter);

    expect(second.senderState).toEqual(identityBefore);
    expect(runtime.deviceGenerationCount).toBe(1);
    expect(second.fanout.rows).toHaveLength(1);
    expect(second.fanout.rows[0]).toMatchObject({
      message_id: 'message-after-purge',
      sender_user_id: runtime.anonymousUserId,
      sender_device_id: runtime.senderDeviceId,
      recipient_user_id: runtime.anonymousUserId,
      recipient_device_id: runtime.receiverDeviceId,
    });
    expect(second.fanout.rows[0].encrypted_body).not.toContain(markerAfter);
    expect(runtime.encryptionCount).toBe(2);
    expect(runtime.invalidations).toBe(0);
  });

  it('fails closed when a sealed device record survives but its Secure Enclave anchor is missing', async () => {
    restoreOrEnrollSenderDevice();
    const generationBeforeFailure = runtime.deviceGenerationCount;

    runtime.webCacheState = null;
    runtime.anchorAvailable = false;

    await expect(sendAnonymousSelfMessage('message-must-not-send', 'blocked'))
      .rejects.toThrow('E2EE_ENCLAVE_ANCHOR_MISSING');
    expect(runtime.deviceGenerationCount).toBe(generationBeforeFailure);
    expect(runtime.encryptionCount).toBe(0);
  });
});
