/* tslint:disable */
/* eslint-disable */
export function aegis_wasm_abi_version(): number;
export function aegis_wasm_identity_generate(): Uint8Array;
export function aegis_wasm_identity_public(secret: Uint8Array): Uint8Array;
/**
 * Retourne record || public || signature, chacun précédé de sa taille u32 LE.
 * Le record est privé ; public et signature sont les seules parties publiables.
 */
export function aegis_wasm_signed_prekey_generate(identity_secret: Uint8Array, key_id: number, timestamp_ms: bigint): Uint8Array;
/**
 * Étape d'envoi compatible avec `deviceRatchet.ts` : retourne
 * nextChainKey || iv || ciphertext+tag, encodés par longueurs u32 LE.
 */
export function aegis_wasm_ratchet_encrypt(chain_key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
/**
 * Étape de réception compatible : retourne nextChainKey || plaintext.
 * L'appelant ne persiste la nouvelle chaîne qu'après authentification réussie.
 */
export function aegis_wasm_ratchet_decrypt(chain_key: Uint8Array, aad: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly aegis_crypto_abi_version: () => number;
  readonly aegis_crypto_buffer_free: (a: number) => void;
  readonly aegis_crypto_identity_generate: (a: number, b: number) => number;
  readonly aegis_crypto_identity_public: (a: number, b: number, c: number) => number;
  readonly aegis_crypto_last_error_message: () => number;
  readonly aegis_crypto_signed_prekey_generate: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number) => number;
  readonly aegis_wasm_abi_version: () => number;
  readonly aegis_wasm_identity_generate: () => [number, number];
  readonly aegis_wasm_identity_public: (a: number, b: number) => [number, number, number, number];
  readonly aegis_wasm_ratchet_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
  readonly aegis_wasm_ratchet_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly aegis_wasm_signed_prekey_generate: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
