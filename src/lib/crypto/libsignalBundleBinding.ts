import { hardCrypto } from './cryptoIntegrity';
import { base64ToBuffer, bufferToBase64, encodeString } from './utils';

export type BundleBindingContext = {
  userId: string; deviceId: string; deviceNumber: number; registrationId: number; publicBundle: string;
};

/** Le contenu signé inclut l'identité Libsignal réelle et toutes ses préclés,
 * ainsi que le compte/appareil destinataire : aucune substitution entre routes. */
export function libsignalBundleBindingPayload(args: BundleBindingContext): string {
  return JSON.stringify({ protocol: 'forsure-libsignal-device-bundle', userId: args.userId,
    deviceId: args.deviceId, deviceNumber: args.deviceNumber,
    registrationId: args.registrationId, publicBundle: args.publicBundle });
}

export function readLibsignalBundleMetadata(bundle: Uint8Array): {
  registrationId: number; deviceNumber: number; preKeyId: number; signedPreKeyId: number; kyberPreKeyId: number;
} {
  if (bundle.length > 196608) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  let offset = 0;
  // Format de sérialisation commun aux bridges Rust WASM et natifs : 7 champs LE.
  for (let field = 0; field < 7; field++) {
    if (offset + 4 > bundle.length) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
    const length = view.getUint32(offset, true);
    offset += 4;
    if (!length || offset + length > bundle.length || (field === 0 && length !== 20)
      || (field === 1 && (length !== 33 || bundle[offset] !== 5))) {
      throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
    }
    offset += length;
  }
  if (offset !== bundle.length) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
  const result = { registrationId: view.getUint32(4, true), deviceNumber: view.getUint32(8, true),
    preKeyId: view.getUint32(12, true), signedPreKeyId: view.getUint32(16, true), kyberPreKeyId: view.getUint32(20, true) };
  if (Object.values(result).some((n) => n === 0) || result.deviceNumber > 127) {
    throw new Error('AEGIS_LIBSIGNAL_BUNDLE_METADATA_INVALID');
  }
  return result;
}

function validateContext(args: BundleBindingContext): Uint8Array {
  if (!args.userId || !args.deviceId || typeof args.publicBundle !== 'string'
    || args.publicBundle.length > 262144) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID');
  const bytes = new Uint8Array(base64ToBuffer(args.publicBundle));
  if (bufferToBase64(bytes.buffer) !== args.publicBundle) throw new Error('AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID');
  const metadata = readLibsignalBundleMetadata(bytes);
  if (metadata.deviceNumber !== args.deviceNumber || metadata.registrationId !== args.registrationId) {
    throw new Error('AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID');
  }
  return bytes;
}

/** À appeler seulement sur le bundle dont la signature a été vérifiée. */
export function libsignalIdentityFromVerifiedBundle(bundle: Uint8Array): Uint8Array {
  readLibsignalBundleMetadata(bundle);
  // Premier champ : longueur u32 + 20 octets ; deuxième : longueur u32 + clé.
  return bundle.slice(28, 61);
}

export async function signLibsignalBundleBinding(args: BundleBindingContext, privateKey: CryptoKey): Promise<string> {
  validateContext(args);
  return bufferToBase64(await hardCrypto.sign('Ed25519', privateKey,
    encodeString(libsignalBundleBindingPayload(args))) as ArrayBuffer);
}

export async function verifyLibsignalBundleBinding(args: BundleBindingContext,
  signature: string, approvedDeviceSigningKey: string): Promise<Uint8Array> {
  try {
    const bundle = validateContext(args);
    if (typeof signature !== 'string' || signature.length !== 88) throw new Error();
    const sig = base64ToBuffer(signature);
    if (sig.byteLength !== 64 || bufferToBase64(sig) !== signature) throw new Error();
    const key = await hardCrypto.importKey('raw', base64ToBuffer(approvedDeviceSigningKey),
      { name: 'Ed25519' }, false, ['verify']);
    if (!await hardCrypto.verify('Ed25519', key, sig, encodeString(libsignalBundleBindingPayload(args)))) throw new Error();
    return bundle;
  } catch {
    throw new Error('AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID');
  }
}
