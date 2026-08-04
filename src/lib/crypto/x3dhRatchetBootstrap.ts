import { establishDeviceSession } from './deviceRatchet';
import { reqToPromise, runTxOn } from './indexedDbTx';

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

async function loadResponderSignedPrekey(
  userId: string,
  deviceId: string,
  spkId: number,
): Promise<StoredDeviceSignedPrekey> {
  const record = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>
    reqToPromise<StoredDeviceSignedPrekey | undefined>(
      tx.objectStore(SPK_STORE).get(deviceSpkKey(userId, deviceId, spkId)),
    ),
  );
  if (!record?.privateKeyJWK || !record.publicKeyBase64) {
    throw new Error('X3DH_RESPONDER_SPK_BOOTSTRAP_MISSING');
  }
  return record;
}

/**
 * Install the responder side of a device-pair Double Ratchet from the exact
 * signed prekey that completed X3DH.
 *
 * The SPK private JWK never leaves the local IndexedDB. It is copied directly
 * into the local ratchet session so the first inbound header can derive the
 * receiving chain. Nothing from this helper is sent to the server or logged.
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
