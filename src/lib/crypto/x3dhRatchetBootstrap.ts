import { establishDeviceSession } from './deviceRatchet';
import { reqToPromise, runTxOn } from './indexedDbTx';
import { readDeviceVaultRecord } from './deviceVault';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';

const SPK_STORE = 'signed-prekeys';

interface StoredDeviceSignedPrekey {
  id: string;
  spkId: number;
  privateKeyJWK: JsonWebKey;
  publicKeyBase64: string;
  createdAt: number;
}

function deviceSpkKey(userId: string, deviceId: string, spkId: number): string {
  return `${userId}::dev::${deviceId}::${spkId}`;
}

function iosVaultSpkKey(id: string): string {
  return `x3dh-prekey::${id}`;
}

function isStoredDeviceSignedPrekey(
  value: unknown,
  expectedId: string,
  expectedSpkId: number,
): value is StoredDeviceSignedPrekey {
  const candidate = value as Partial<StoredDeviceSignedPrekey> | null;
  return Boolean(
    candidate &&
    candidate.id === expectedId &&
    candidate.spkId === expectedSpkId &&
    candidate.privateKeyJWK &&
    typeof candidate.privateKeyJWK === 'object' &&
    typeof candidate.publicKeyBase64 === 'string' &&
    candidate.publicKeyBase64.length >= 40 &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  );
}

async function loadResponderSignedPrekey(
  userId: string,
  deviceId: string,
  spkId: number,
): Promise<StoredDeviceSignedPrekey> {
  const id = deviceSpkKey(userId, deviceId, spkId);

  // Windows/desktop Web and existing native flows keep the historical lookup
  // untouched. This remains the first and authoritative read on those paths.
  const legacy = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>
    reqToPromise<StoredDeviceSignedPrekey | undefined>(
      tx.objectStore(SPK_STORE).get(id),
    ),
  ).catch(() => undefined);

  if (legacy?.privateKeyJWK && legacy.publicKeyBase64) {
    return legacy;
  }

  // iOS Web/PWA is the only Web path where x3dh.ts deliberately purges the
  // plaintext SPK mirror after sealing it in ACE. Bootstrap must therefore
  // recover the exact same SPK from DeviceVault instead of treating it as lost.
  if (isIosWebRuntime()) {
    const sealed = await readDeviceVaultRecord(
      iosVaultSpkKey(id),
      (value): value is StoredDeviceSignedPrekey =>
        isStoredDeviceSignedPrekey(value, id, spkId),
    );
    if (sealed) return sealed;
  }

  throw new Error('X3DH_RESPONDER_SPK_BOOTSTRAP_MISSING');
}

/**
 * Install the responder side of a device-pair Double Ratchet from the exact
 * signed prekey that completed X3DH.
 *
 * Windows/desktop Web keeps its historical IndexedDB SPK lookup. iOS Web/PWA
 * stores the private SPK in ACE, so this helper falls back to the sealed
 * DeviceVault record only on iOS Web. The private key never leaves the client.
 */
export async function establishResponderRatchetFromDeviceX3DH(args: {
  myUserId: string;
  myDeviceId: string;
  peerUserId: string;
  peerDeviceId: string;
  sharedSecret: ArrayBuffer;
  sessionId: string;
  spkId: number;
  selfIkPubB64: string;
  peerIkPubB64: string;
}): Promise<string> {
  const spk = await loadResponderSignedPrekey(
    args.myUserId,
    args.myDeviceId,
    args.spkId,
  );

  return establishDeviceSession(
    args.myUserId,
    args.myDeviceId,
    args.peerUserId,
    args.peerDeviceId,
    args.sharedSecret,
    args.sessionId,
    {
      isInitiator: false,
      peerSpkId: args.spkId,
      selfInitialDhPrivJwk: spk.privateKeyJWK,
      selfInitialDhPubB64: spk.publicKeyBase64,
      selfIkPubB64: args.selfIkPubB64,
      peerIkPubB64: args.peerIkPubB64,
    },
  );
}
