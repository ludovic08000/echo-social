/**
 * Chargeur libsignal WebAssembly pour Windows Web.
 *
 * Le bridge ne persiste rien : tout record privé doit être remis au vault
 * Windows Hello avant que l'appelant publie la partie publique correspondante.
 */
import initWasm, {
  aegis_wasm_abi_version,
  aegis_wasm_identity_generate,
  aegis_wasm_identity_public,
  aegis_wasm_ratchet_decrypt,
  aegis_wasm_ratchet_encrypt,
  aegis_wasm_signed_prekey_generate,
} from './wasm/generated/aegis_crypto.js';

const EXPECTED_ABI = 1;
let initPromise: Promise<void> | null = null;

export type WasmSignedPrekey = {
  privateRecord: Uint8Array;
  publicKey: Uint8Array;
  signature: Uint8Array;
};

function unpackParts(packed: Uint8Array, expectedParts: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; index < expectedParts; index += 1) {
    if (offset + 4 > packed.length) throw new Error('AEGIS_WASM_PACK_INVALID');
    const length = new DataView(packed.buffer, packed.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    if (length === 0 || offset + length > packed.length) throw new Error('AEGIS_WASM_PACK_INVALID');
    parts.push(packed.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== packed.length) throw new Error('AEGIS_WASM_PACK_INVALID');
  return parts;
}

function ensureWindowsWeb(): void {
  if (typeof window === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('AEGIS_WASM_RUNTIME_UNAVAILABLE');
  }
  if (!/Windows/i.test(navigator.userAgent || '')) {
    throw new Error('AEGIS_WASM_WINDOWS_ONLY');
  }
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error('AEGIS_WASM_SECURE_CONTEXT_REQUIRED');
  }
}

export async function initializeAegisWasm(): Promise<void> {
  ensureWindowsWeb();
  initPromise ??= (async () => {
    await initWasm();
    if (aegis_wasm_abi_version() !== EXPECTED_ABI) {
      throw new Error('AEGIS_WASM_ABI_MISMATCH');
    }
  })().catch((error) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

export function unpackWasmSignedPrekey(packed: Uint8Array): WasmSignedPrekey {
  const parts = unpackParts(packed, 3);
  return { privateRecord: parts[0], publicKey: parts[1], signature: parts[2] };
}

export async function wasmRatchetEncrypt(args: {
  chainKey: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
}): Promise<{ nextChainKey: Uint8Array; iv: Uint8Array; ciphertext: Uint8Array }> {
  await initializeAegisWasm();
  const [nextChainKey, iv, ciphertext] = unpackParts(aegis_wasm_ratchet_encrypt(
    args.chainKey, args.aad, args.plaintext,
  ), 3);
  if (nextChainKey.length !== 32 || iv.length !== 12 || ciphertext.length < 16) {
    throw new Error('AEGIS_WASM_RATCHET_OUTPUT_INVALID');
  }
  return { nextChainKey, iv, ciphertext };
}

export async function wasmRatchetDecrypt(args: {
  chainKey: Uint8Array;
  aad: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}): Promise<{ nextChainKey: Uint8Array; plaintext: Uint8Array }> {
  await initializeAegisWasm();
  const [nextChainKey, plaintext] = unpackParts(aegis_wasm_ratchet_decrypt(
    args.chainKey, args.aad, args.iv, args.ciphertext,
  ), 2);
  if (nextChainKey.length !== 32) throw new Error('AEGIS_WASM_RATCHET_OUTPUT_INVALID');
  return { nextChainKey, plaintext };
}

export async function generateWasmIdentity(): Promise<{
  privateRecord: Uint8Array;
  publicKey: Uint8Array;
}> {
  await initializeAegisWasm();
  const privateRecord = aegis_wasm_identity_generate();
  const publicKey = aegis_wasm_identity_public(privateRecord);
  return { privateRecord, publicKey };
}

export async function generateWasmSignedPrekey(
  identityPrivateRecord: Uint8Array,
  keyId: number,
  timestampMs = Date.now(),
): Promise<WasmSignedPrekey> {
  await initializeAegisWasm();
  if (!Number.isSafeInteger(keyId) || keyId <= 0 || keyId > 0x7fffffff) {
    throw new Error('AEGIS_WASM_SPK_ID_INVALID');
  }
  return unpackWasmSignedPrekey(aegis_wasm_signed_prekey_generate(
    identityPrivateRecord,
    keyId,
    BigInt(timestampMs),
  ));
}
