/**
 * Bridge libsignal WebAssembly : chaque mutation du store est scellée et
 * relue dans le coffre de l'appareil avant de rendre le résultat à l'appelant.
 */
import initWasm, {
  aegis_wasm_abi_version,
  aegis_wasm_identity_generate,
  aegis_wasm_identity_public,
  aegis_wasm_store_create,
  aegis_wasm_bundle_create,
  aegis_wasm_session_establish,
  aegis_wasm_message_encrypt,
  aegis_wasm_message_decrypt,
} from './wasm/generated/aegis_crypto.js';
import { readDeviceVaultRecord, writeDeviceVaultRecord } from './deviceVault';
import { base64ToBuffer, bufferToBase64 } from './utils';
import { withLibsignalStoreLock as withStoreLock } from './libsignalStoreLock';
import { traceFinalizationOperation } from '@/lib/device-manager/deviceFinalizationTrace';

const EXPECTED_ABI = 1;
const LIBSIGNAL_STORE_PREFIX = 'aegis.libsignal.store:';
let initPromise: Promise<void> | null = null;

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

type SealedLibsignalStore = { bytes: string };
const validStore = (value: unknown): value is SealedLibsignalStore =>
  typeof value === 'object' && value !== null &&
  typeof (value as SealedLibsignalStore).bytes === 'string' &&
  (value as SealedLibsignalStore).bytes.length > 0;

function vaultId(userId: string, deviceId: string): string {
  return `${LIBSIGNAL_STORE_PREFIX}${userId}:${deviceId}`;
}

function toBase64(bytes: Uint8Array): string {
  return bufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

async function loadStore(userId: string, deviceId: string): Promise<Uint8Array> {
  const record = await traceFinalizationOperation('wasm.vault_read', () => readDeviceVaultRecord(vaultId(userId, deviceId), validStore), { userId, deviceId });
  if (!record) throw new Error('AEGIS_LIBSIGNAL_STORE_MISSING');
  return new Uint8Array(base64ToBuffer(record.bytes));
}

async function commitStore(userId: string, deviceId: string, bytes: Uint8Array): Promise<void> {
  const id = vaultId(userId, deviceId);
  const record = { bytes: toBase64(bytes) } satisfies SealedLibsignalStore;
  await traceFinalizationOperation('wasm.vault_write', () => writeDeviceVaultRecord(id, record), { userId, deviceId });
  const readback = await traceFinalizationOperation('wasm.vault_readback', () => readDeviceVaultRecord(id, validStore), { userId, deviceId });
  if (!readback || readback.bytes !== record.bytes) throw new Error('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED');
}

export async function initializeAegisWasm(): Promise<void> {
  ensureWebAssemblyRuntime();
  initPromise ??= (async () => {
    await traceFinalizationOperation('wasm.initialize', () => initWasm());
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
    const [nextStore, publicBundle] = unpackParts(await traceFinalizationOperation('wasm.bundle_crypto',
      () => aegis_wasm_bundle_create(store, args.deviceNumber, args.preKeyId, args.signedPreKeyId, args.kyberPreKeyId),
      { userId: args.userId, deviceId: args.deviceId }), 2);
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
  await withStoreLock(userId, deviceId, async () => {
    const existing = await readDeviceVaultRecord(vaultId(userId, deviceId), validStore);
    // Une sauvegarde ne doit jamais faire reculer un ratchet déjà présent.
    if (existing) {
      if (existing.bytes !== bytes) throw new Error('AEGIS_LIBSIGNAL_RESTORE_CONFLICT');
      return;
    }
    await commitStore(userId, deviceId, new Uint8Array(base64ToBuffer(bytes)));
  });
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
