/**
 * KDF Chain tests — forward secrecy verification
 */
import { describe, it, expect } from 'vitest';
import { kdfChainStepExportable, kdfRootStep } from '../kdfChain';

async function makeChainKey(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    true, ['sign'],
  );
}

describe('kdfChainStep', () => {
  it('produces different chain key and message key', async () => {
    const ck = await makeChainKey();
    const { nextChainKey, messageKey } = await kdfChainStepExportable(ck);

    const ckRaw = await crypto.subtle.exportKey('raw', nextChainKey);
    const mkRaw = await crypto.subtle.exportKey('raw', messageKey);
    expect(new Uint8Array(ckRaw)).not.toEqual(new Uint8Array(mkRaw));
  });

  it('chain step is deterministic for same input', async () => {
    const raw = new Uint8Array(32).fill(42);
    const ck1 = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']);
    const ck2 = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']);

    const r1 = await kdfChainStepExportable(ck1);
    const r2 = await kdfChainStepExportable(ck2);

    const mk1 = new Uint8Array(await crypto.subtle.exportKey('raw', r1.messageKey));
    const mk2 = new Uint8Array(await crypto.subtle.exportKey('raw', r2.messageKey));
    expect(mk1).toEqual(mk2);
  });

  it('successive steps produce unique message keys (forward secrecy)', async () => {
    let ck = await makeChainKey();
    const messageKeys: string[] = [];

    for (let i = 0; i < 5; i++) {
      const { nextChainKey, messageKey } = await kdfChainStepExportable(ck);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', messageKey));
      messageKeys.push(Array.from(raw).join(','));
      ck = nextChainKey;
    }

    const unique = new Set(messageKeys);
    expect(unique.size).toBe(5);
  });
});

describe('kdfRootStep', () => {
  it('produces new root key and chain key from DH output', async () => {
    const rootKey = await makeChainKey();
    const dhOutput = crypto.getRandomValues(new Uint8Array(32)).buffer;

    const { newRootKey, newChainKey } = await kdfRootStep(rootKey, dhOutput);
    
    expect(newRootKey).toBeDefined();
    expect(newChainKey).toBeDefined();

    const rkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', newRootKey));
    const ckRaw = new Uint8Array(await crypto.subtle.exportKey('raw', newChainKey));
    expect(rkRaw).not.toEqual(ckRaw);
  });
});
