/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const aegis_crypto_abi_version: () => number;
export const aegis_crypto_buffer_free: (a: number) => void;
export const aegis_crypto_identity_generate: (a: number, b: number) => number;
export const aegis_crypto_identity_public: (a: number, b: number, c: number) => number;
export const aegis_crypto_last_error_message: () => number;
export const aegis_crypto_signed_prekey_generate: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number) => number;
export const aegis_wasm_abi_version: () => number;
export const aegis_wasm_identity_generate: () => [number, number];
export const aegis_wasm_identity_public: (a: number, b: number) => [number, number, number, number];
export const aegis_wasm_ratchet_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
export const aegis_wasm_ratchet_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const aegis_wasm_signed_prekey_generate: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_export_2: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
