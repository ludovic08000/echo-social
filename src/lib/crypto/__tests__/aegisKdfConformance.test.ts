import { describe, expect, it } from 'vitest';
import { kdfChainStep, kdfRootStep, importChainKey } from '../kdfChain';
import { RATCHET_MAX_SKIP, RATCHET_SKIPPED_TTL_MS } from '../constants';
import { hardCrypto } from '../cryptoIntegrity';
import { base64ToBuffer, bufferToBase64 } from '../utils';

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function exportRaw(key: CryptoKey): Promise<string> {
  return hex(await hardCrypto.exportKey('raw', key));
}

describe('Aegis Double-Ratchet invariants', () => {
  it('keeps skipped-key work and retention bounded', () => {
    expect(RATCHET_MAX_SKIP).toBe(1000);
    expect(RATCHET_SKIPPED_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('derives the frozen chain-key and message-key bytes', async () => {
    const seed = new Uint8Array(32).fill(0xaa).buffer;
    const chainKey = await importChainKey(seed);
    const { nextChainKey, messageKey } = await kdfChainStep(chainKey);

    expect(messageKey.algorithm.name).toBe('AES-GCM');
    expect((messageKey.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(nextChainKey.algorithm.name).toBe('HMAC');

    const seedKey = await hardCrypto.importKey(
      'raw',
      seed,
      { name: 'HMAC', hash: 'SHA-256' } as HmacImportParams,
      false,
      ['sign'],
    );
    const messageBytes = await hardCrypto.sign('HMAC', seedKey, new Uint8Array([0x01]));
    const chainBytes = await hardCrypto.sign('HMAC', seedKey, new Uint8Array([0x02]));
    expect(hex(messageBytes)).toBe('790519613efaec118e63904e01475b9543b9a15c61070227d877418c8cca415e');
    expect(hex(chainBytes)).toBe('e3593f75e832b460cfc9cdea5a65902f94d9213060090c0e00a5a74306389e2e');
  });

  it('derives deterministic, separated root and chain keys', async () => {
    const rootKey = await hardCrypto.importKey(
      'raw',
      new Uint8Array(32).fill(0x11),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as HmacImportParams,
      true,
      ['sign'],
    );
    const dh = new Uint8Array(32).fill(0x22).buffer;
    const first = await kdfRootStep(rootKey, dh);
    const second = await kdfRootStep(rootKey, dh);

    expect(await exportRaw(first.newRootKey)).toBe(await exportRaw(second.newRootKey));
    expect(await exportRaw(first.newChainKey)).toBe(await exportRaw(second.newChainKey));
    expect(await exportRaw(first.newRootKey)).not.toBe(await exportRaw(first.newChainKey));
  });

  it('preserves bytes through base64 serialization', () => {
    const raw = new Uint8Array([0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
    expect(new Uint8Array(base64ToBuffer(bufferToBase64(raw.buffer)))).toEqual(raw);
  });
});
