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
  aegis_wasm_store_create,
  aegis_wasm_bundle_create,
  aegis_wasm_session_establish,
  aegis_wasm_message_encrypt,
  aegis_wasm_message_decrypt,
} from './wasm/generated/aegis_crypto.js';
import { readDeviceVaultRecord, writeDeviceVaultRecord } from './deviceVault';
import { base64ToBuffer, bufferToBase64 } from './utils';

const EXPECTED_ABI = 1;
const LIBSIGNAL_STORE_PREFIX = 'aegis.libsignal.store:';
let initPromise: Promise<void> | null = null;
const storeQueues = new Map<string, Promise<void>>();

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

function ensureWebAssemblyRuntime(): void {
  if (typeof window === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('AEGIS_WASM_RUNTIME_UNAVAILABLE');
  }
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error('AEGIS_WASM_SECURE_CONTEXT_REQUIRED');
  }
}

function ensureWindowsWeb(): void {
  ensureWebAssemblyRuntime();
  if (!/Windows/i.test(navigator.userAgent || '')) throw new Error('AEGIS_WASM_WINDOWS_ONLY');
}

type SealedLibsignalStore = { bytes: string };
const validStore = (value: unknown): value is SealedLibsignalStore =>
  typeof value === 'object' && value !== null &&
  typeof (value as SealedLibsignalStore).bytes === 'string' &&
  (value as SealedLibsignalStore).bytes.length > 0;

function vaultId(userId: string, deviceId: string): string {
  return `${LIBSIGNAL_STORE_PREFIX}${userId}:${deviceId}`;
}

async function withStoreLock<T>(userId: string, deviceId: string, work: () => Promise<T>): Promise<T> {
  const key = vaultId(userId, deviceId);
  const previous = storeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  storeQueues.set(key, queued);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (storeQueues.get(key) === queued) storeQueues.delete(key);
  }
}

function toBase64(bytes: Uint8Array): string {
  return bufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

async function loadStore(userId: string, deviceId: string): Promise<Uint8Array> {
  const record = await readDeviceVaultRecord(vaultId(userId, deviceId), validStore);
  if (!record) throw new Error('AEGIS_LIBSIGNAL_STORE_MISSING');
  return new Uint8Array(base64ToBuffer(record.bytes));
}

async function commitStore(userId: string, deviceId: string, bytes: Uint8Array): Promise<void> {
  const id = vaultId(userId, deviceId);
  const record = { bytes: toBase64(bytes) } satisfies SealedLibsignalStore;
  await writeDeviceVaultRecord(id, record);
  const readback = await readDeviceVaultRecord(id, validStore);
  if (!readback || readback.bytes !== record.bytes) throw new Error('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED');
}

export async function initializeAegisWasm(): Promise<void> {
  ensureWebAssemblyRuntime();
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

export type LibsignalAddress = { userId: string; deviceNumber: number };
export type LibsignalCiphertext = { messageType: number; ciphertext: Uint8Array };

export async function createLibsignalStore(args: { userId: string; deviceId: string; registrationId: number }): Promise<void> {
  await initializeAegisWasm();
  await withStoreLock(args.userId, args.deviceId, async () => {
    const existing = await readDeviceVaultRecord(vaultId(args.userId, args.deviceId), validStore);
    if (!existing) await commitStore(args.userId, args.deviceId, aegis_wasm_store_create(args.registrationId));
  });
}

export async function createLibsignalBundle(args: { userId: string; deviceId: string; deviceNumber: number; preKeyId: number; signedPreKeyId: number; kyberPreKeyId: number }): Promise<Uint8Array> {
  await initializeAegisWasm();
  return withStoreLock(args.userId, args.deviceId, async () => {
    const store = await loadStore(args.userId, args.deviceId);
    const [nextStore, publicBundle] = unpackParts(await aegis_wasm_bundle_create(store, args.deviceNumber, args.preKeyId, args.signedPreKeyId, args.kyberPreKeyId), 2);
  // Publication interdite tant que le store contenant les privés n'est pas durable.
  await commitStore(args.userId, args.deviceId, nextStore);
    return publicBundle;
  });
}

export async function establishLibsignalSession(args: { ownerUserId: string; ownerDeviceId: string; local: LibsignalAddress; remote: LibsignalAddress; bundle: Uint8Array }): Promise<void> {
  await initializeAegisWasm();
  await withStoreLock(args.ownerUserId, args.ownerDeviceId, async () => {
    const store = await loadStore(args.ownerUserId, args.ownerDeviceId);
    const nextStore = await aegis_wasm_session_establish(store, args.local.userId, args.local.deviceNumber, args.remote.userId, args.remote.deviceNumber, args.bundle);
    await commitStore(args.ownerUserId, args.ownerDeviceId, nextStore);
  });
}

export async function encryptLibsignalMessage(args: { ownerUserId: string; ownerDeviceId: string; local: LibsignalAddress; remote: LibsignalAddress; plaintext: Uint8Array }): Promise<LibsignalCiphertext> {
  await initializeAegisWasm();
  return withStoreLock(args.ownerUserId, args.ownerDeviceId, async () => {
    const store = await loadStore(args.ownerUserId, args.ownerDeviceId);
  const [nextStore, type, ciphertext] = unpackParts(await aegis_wasm_message_encrypt(store, args.local.userId, args.local.deviceNumber, args.remote.userId, args.remote.deviceNumber, args.plaintext), 3);
  if (type.length !== 1) throw new Error('AEGIS_LIBSIGNAL_MESSAGE_TYPE_INVALID');
  await commitStore(args.ownerUserId, args.ownerDeviceId, nextStore);
    return { messageType: type[0], ciphertext };
  });
}

export async function decryptLibsignalMessage(args: { ownerUserId: string; ownerDeviceId: string; local: LibsignalAddress; remote: LibsignalAddress; encrypted: LibsignalCiphertext }): Promise<Uint8Array> {
  await initializeAegisWasm();
  return withStoreLock(args.ownerUserId, args.ownerDeviceId, async () => {
    const store = await loadStore(args.ownerUserId, args.ownerDeviceId);
  const [nextStore, plaintext] = unpackParts(await aegis_wasm_message_decrypt(store, args.local.userId, args.local.deviceNumber, args.remote.userId, args.remote.deviceNumber, args.encrypted.messageType, args.encrypted.ciphertext), 2);
  // Aucun plaintext n'est rendu si l'avancement du ratchet n'est pas durable.
  await commitStore(args.ownerUserId, args.ownerDeviceId, nextStore);
    return plaintext;
  });
}

export async function captureLibsignalStore(userId: string, deviceId: string): Promise<string> {
  return withStoreLock(userId, deviceId, async () => toBase64(await loadStore(userId, deviceId)));
}

export async function restoreLibsignalStore(userId: string, deviceId: string, bytes: string): Promise<void> {
  if (!bytes) throw new Error('AEGIS_LIBSIGNAL_STORE_INVALID');
  await withStoreLock(userId, deviceId, () => commitStore(userId, deviceId, new Uint8Array(base64ToBuffer(bytes))));
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
  ensureWindowsWeb();
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
  ensureWindowsWeb();
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
