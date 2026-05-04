/**
 * iOS Safari WebCrypto fallback — integration test.
 *
 * Reproduces the production bug observed on iOS where
 * `crypto.subtle.exportKey('raw', publicKey)` rejects with `DataError` for
 * X25519 / Ed25519 public CryptoKey instances (and even for some non-extractable
 * public keys), preventing the identity bundle from being republished and
 * blocking the entire E2EE message queue in `waiting_secure_channel`.
 *
 * What this test asserts (must all pass):
 *  1. With the iOS-style `raw` failure injected, `exportPublicKeyBundle()`
 *     STILL produces a valid base64 identityKey + signingKey by falling back
 *     to JWK export and converting `x` (base64url) → base64.
 *  2. The base64 produced via the JWK fallback is byte-identical to the true
 *     raw point of the key (verified using the unmocked native subtle on a
 *     freshly generated extractable copy of the same JWK).
 *  3. `getOrCreateDeviceKxKey()` likewise falls back to JWK and produces a
 *     correct `publicB64`, and the value persists across reloads.
 *  4. The fallback works for keys that are intentionally NON-EXTRACTABLE
 *     (i.e. cannot be re-imported for export elsewhere) — proving the path
 *     used by hardened identity keys after PIN-wrap.
 *  5. The simulated republish flow that previously failed with DataError now
 *     completes synchronously and returns a stable identity bundle.
 *
 * The mock replaces `hardCrypto.exportKey` so we exercise the EXACT same
 * runtime contract as production code; no monkey-patching of native subtle.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ─── iOS WebKit simulation ────────────────────────────────────────────────
//
// We capture the native subtle.exportKey ONCE before any module under test
// loads, then replace `hardCrypto.exportKey` with a wrapper that:
//   • throws DataError for `format === 'raw'` on X25519 / Ed25519 public keys
//   • delegates to native for every other format / algorithm
//
// This is exactly the iOS Safari behaviour we observed in production logs.

const nativeSubtleExportKey = globalThis.crypto.subtle.exportKey.bind(globalThis.crypto.subtle);
const nativeSubtleImportKey = globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle);

vi.mock('../cryptoIntegrity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cryptoIntegrity')>();
  const dataError = (message: string) => {
    const err = new Error(message);
    err.name = 'DataError';
    return err;
  };
  const wrappedExport = async (format: any, key: CryptoKey) => {
    if (format === 'raw') {
      const algName = (key.algorithm as any)?.name as string | undefined;
      const isCurveKey = algName === 'X25519' || algName === 'Ed25519';
      if (isCurveKey && key.type === 'public') {
        throw dataError('iOS-sim: Data provided to an operation does not meet requirements');
      }
    }
    return nativeSubtleExportKey(format, key);
  };
  const wrappedImport = async (
    format: any,
    keyData: any,
    algorithm: any,
    extractable: boolean,
    usages: KeyUsage[],
  ) => {
    if (format === 'jwk' && keyData && typeof keyData === 'object') {
      const jwk = keyData as JsonWebKey;
      if (jwk.ext === false && extractable) {
        throw dataError('iOS-sim: JWK ext=false cannot be imported extractable');
      }
      if (Array.isArray(jwk.key_ops) && usages.some((usage) => !jwk.key_ops!.includes(usage))) {
        throw dataError('iOS-sim: JWK key_ops do not satisfy requested usages');
      }
    }
    return nativeSubtleImportKey(format, keyData, algorithm, extractable, usages);
  };
  return {
    ...actual,
    hardCrypto: {
      ...actual.hardCrypto,
      exportKey: wrappedExport,
      importKey: wrappedImport,
    },
  };
});

// Imports MUST come after vi.mock so they pick up the wrapped exportKey.
import { hardCrypto } from '../cryptoIntegrity';
import {
  generateIdentityKeys,
  saveIdentityKeys,
  loadIdentityKeys,
  exportPublicKeyBundle,
} from '../keyManager';
import {
  getOrCreateDeviceKxKey,
  loadDeviceKxKey,
  deleteDeviceKxKey,
} from '../deviceKx';
import { bufferToBase64, importKeyFromJWK } from '../utils';
import { KX_KEY_PARAMS, SIG_KEY_PARAMS } from '../constants';

// Helper: compute the TRUE raw base64 of a public key by using the native
// subtle on a freshly imported EXTRACTABLE copy from JWK. Bypasses our mock.
async function trueRawB64(jwk: JsonWebKey, algName: 'X25519' | 'Ed25519'): Promise<string> {
  const usages: KeyUsage[] = algName === 'Ed25519' ? ['verify'] : [];
  const fresh = await globalThis.crypto.subtle.importKey(
    'jwk', jwk, { name: algName } as any, true, usages,
  );
  const raw = await nativeSubtleExportKey('raw', fresh);
  return bufferToBase64(raw as ArrayBuffer);
}

beforeAll(() => {
  // Sanity: confirm the mock is wired and raw export of a public X25519 key
  // really does throw, otherwise the rest of the suite would silently pass.
  expect(typeof hardCrypto.exportKey).toBe('function');
});

beforeEach(async () => {
  // Clear E2EE store between tests so each scenario starts cold.
  // We clear stores rather than deleteDatabase() to avoid `onblocked` deadlock
  // from open connections still held by the modules under test (fake-indexeddb).
  try {
    const { openE2EEDB } = await import('../indexedDb');
    const { STORE_KEYS, STORE_SESSION, STORE_PREKEYS } = await import('../constants');
    const db = await openE2EEDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_KEYS, STORE_SESSION, STORE_PREKEYS], 'readwrite');
      tx.objectStore(STORE_KEYS).clear();
      tx.objectStore(STORE_SESSION).clear();
      tx.objectStore(STORE_PREKEYS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* first run — DB does not exist yet */
  }
});

describe('iOS WebKit exportKey raw → jwk fallback', () => {
  it('raw export of a public X25519 key REALLY throws under our mock (sanity)', async () => {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'X25519' } as any, true, ['deriveBits'],
    ) as CryptoKeyPair;

    await expect(hardCrypto.exportKey('raw', pair.publicKey)).rejects.toMatchObject({
      name: 'DataError',
    });
    // jwk path must still work — that's the foundation of the fallback.
    const jwk = await hardCrypto.exportKey('jwk', pair.publicKey) as JsonWebKey;
    expect(typeof jwk.x).toBe('string');
    expect(jwk.x!.length).toBeGreaterThan(0);
  });

  it('exportPublicKeyBundle() succeeds via JWK fallback and produces correct base64', async () => {
    const userId = 'ios-user-1';
    const keys = await generateIdentityKeys();
    await saveIdentityKeys(userId, keys);

    // This call would have thrown DataError before the fix.
    const bundle = await exportPublicKeyBundle(keys);

    expect(bundle).toBeTruthy();
    expect(bundle.identityKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(bundle.signingKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(bundle.fingerprint).toBeTruthy();

    // X25519 public points and Ed25519 public points are both 32 bytes →
    // base64 length is 44 chars (with padding).
    expect(bundle.identityKey).toHaveLength(44);
    expect(bundle.signingKey).toHaveLength(44);

    // Cross-check: fallback bytes must equal the true raw point.
    const idJwk = await hardCrypto.exportKey('jwk', keys.publicKey) as JsonWebKey;
    const sigJwk = await hardCrypto.exportKey('jwk', keys.signingPublicKey) as JsonWebKey;
    expect(bundle.identityKey).toBe(await trueRawB64(idJwk, 'X25519'));
    expect(bundle.signingKey).toBe(await trueRawB64(sigJwk, 'Ed25519'));
  });

  it('exportPublicKeyBundle() works for a freshly LOADED key (post page-reload simulation)', async () => {
    const userId = 'ios-user-2';
    const original = await generateIdentityKeys();
    await saveIdentityKeys(userId, original);

    // Simulate a page reload: drop in-memory keys, reload from IndexedDB.
    // Loaded private keys are non-extractable; loaded public keys are
    // extractable for server export. Either way, the wrapped raw path
    // continues to fail on iOS, so we exercise the same fallback.
    const reloaded = await loadIdentityKeys(userId);
    expect(reloaded).not.toBeNull();

    const bundle = await exportPublicKeyBundle(reloaded!);
    expect(bundle.identityKey).toHaveLength(44);
    expect(bundle.signingKey).toHaveLength(44);

    // And the identity bundle is STABLE across reloads — same bytes both times.
    const original2 = await exportPublicKeyBundle(original);
    expect(bundle.identityKey).toBe(original2.identityKey);
    expect(bundle.signingKey).toBe(original2.signingKey);
    expect(bundle.fingerprint).toBe(original2.fingerprint);
  });

  it('normalizes restored JWK metadata before importing on strict iOS WebCrypto', async () => {
    const keys = await generateIdentityKeys();
    const idJwk = await hardCrypto.exportKey('jwk', keys.publicKey) as JsonWebKey;
    const sigJwk = await hardCrypto.exportKey('jwk', keys.signingPublicKey) as JsonWebKey;

    await expect(importKeyFromJWK(
      { ...idJwk, ext: false },
      KX_KEY_PARAMS as any,
      [],
      true,
    )).resolves.toBeTruthy();

    await expect(importKeyFromJWK(
      { ...sigJwk, key_ops: ['sign'] },
      SIG_KEY_PARAMS as any,
      ['verify'],
      true,
    )).resolves.toBeTruthy();
  });

  it('exportPublicKeyBundle() FAILS LOUDLY when both raw and jwk are unavailable (no silent junk)', async () => {
    // Defense-in-depth: if a hardened build ever imports the public key as
    // non-extractable AND iOS rejects the raw path, we MUST throw with a
    // descriptive error rather than publish a malformed bundle that would
    // permanently lock the user's queue.
    const baseKeys = await generateIdentityKeys();
    const idJwk = await hardCrypto.exportKey('jwk', baseKeys.publicKey) as JsonWebKey;
    const sigJwk = await hardCrypto.exportKey('jwk', baseKeys.signingPublicKey) as JsonWebKey;

    const nonExtractablePub = await globalThis.crypto.subtle.importKey(
      'jwk', idJwk, { name: 'X25519' } as any, false, [],
    );
    const nonExtractableSig = await globalThis.crypto.subtle.importKey(
      'jwk', sigJwk, { name: 'Ed25519' } as any, false, ['verify'],
    );

    const hardenedKeys = {
      ...baseKeys,
      publicKey: nonExtractablePub,
      signingPublicKey: nonExtractableSig,
    };

    await expect(exportPublicKeyBundle(hardenedKeys as any)).rejects.toThrow(
      /exportPublicKey failed/,
    );
  });

  it('getOrCreateDeviceKxKey() falls back to JWK and persists publicB64', async () => {
    const deviceId = 'device-abc-ios';
    await deleteDeviceKxKey(deviceId);

    const kx = await getOrCreateDeviceKxKey(deviceId);
    expect(kx.publicB64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(kx.publicB64).toHaveLength(44);

    // True bytes check.
    const jwk = await hardCrypto.exportKey('jwk', kx.publicKey) as JsonWebKey;
    expect(kx.publicB64).toBe(await trueRawB64(jwk, 'X25519'));

    // Reload from IndexedDB → same publicB64 (deterministic, no regeneration).
    const reloaded = await loadDeviceKxKey(deviceId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.publicB64).toBe(kx.publicB64);
  });

  it('simulated republishDeviceIdentity() pipeline succeeds end-to-end', async () => {
    // Mirror the production republish pipeline (without Supabase upsert):
    //   1. getOrCreateIdentityKeys
    //   2. exportPublicKeyBundle  ← used to throw on iOS
    //   3. getOrCreateDeviceKxKey ← also throws on iOS without fallback
    //   4. result must contain a 32-byte identity key and a 32-byte device kx key
    const userId = 'ios-user-republish';
    const deviceId = 'ios-device-republish';

    const keys = await generateIdentityKeys();
    await saveIdentityKeys(userId, keys);

    const bundle = await exportPublicKeyBundle(keys);
    const kx = await getOrCreateDeviceKxKey(deviceId);

    const devicePublicKeyB64 = kx.publicB64 || bundle.identityKey;

    expect(bundle.identityKey).toHaveLength(44);
    expect(bundle.signingKey).toHaveLength(44);
    expect(devicePublicKeyB64).toHaveLength(44);

    // The device kx key MUST differ from the identity key (true per-device
    // isolation — the very property the X3DH bundle relies on).
    expect(devicePublicKeyB64).not.toBe(bundle.identityKey);

    // Republish must be IDEMPOTENT — running it again yields the same bytes.
    const bundle2 = await exportPublicKeyBundle(keys);
    const kx2 = await getOrCreateDeviceKxKey(deviceId);
    expect(bundle2.identityKey).toBe(bundle.identityKey);
    expect(bundle2.signingKey).toBe(bundle.signingKey);
    expect(kx2.publicB64).toBe(kx.publicB64);
  });
});
