/**
 * Double Ratchet tests — full conversation flow
 */
import { describe, it, expect } from 'vitest';
import {
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
} from '../ratchet';
import { bufferToBase64 } from '../utils';

const KX = { name: 'X25519' } as any;
const SIG = { name: 'Ed25519' } as any;

async function makeSharedSecret(): Promise<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(64)).buffer;
}

async function setupAliceAndBob() {
  const sharedSecret = await makeSharedSecret();

  // Bob generates his DH pair first (responder)
  const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;

  // Identity keys (required for v4 envelope AAD)
  const aliceIK = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const bobIK = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const aliceIKB64 = bufferToBase64(await crypto.subtle.exportKey('raw', aliceIK.publicKey));
  const bobIKB64 = bufferToBase64(await crypto.subtle.exportKey('raw', bobIK.publicKey));

  // Alice (initiator): myIK = Alice, peerIK = Bob
  const aliceState = await initRatchetAsInitiator('conv-1', sharedSecret, bobDhPair.publicKey, {
    myIdentityKeyB64: aliceIKB64,
    peerIdentityKeyB64: bobIKB64,
  });

  // Bob (responder): myIK = Bob, peerIK = Alice
  const bobState = await initRatchetAsResponder('conv-1', sharedSecret, bobDhPair, {
    myIdentityKeyB64: bobIKB64,
    peerIdentityKeyB64: aliceIKB64,
  });

  // Signing keys
  const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const bobSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;

  const aliceSigPubB64 = bufferToBase64(await crypto.subtle.exportKey('raw', aliceSig.publicKey));
  const bobSigPubB64 = bufferToBase64(await crypto.subtle.exportKey('raw', bobSig.publicKey));

  return { aliceState, bobState, aliceSig, bobSig, aliceSigPubB64, bobSigPubB64 };
}

describe('Double Ratchet', () => {
  it('Alice encrypts → Bob decrypts', async () => {
    const { aliceState, bobState, aliceSig, aliceSigPubB64 } = await setupAliceAndBob();

    const { envelope, newState: aliceNew } = await ratchetEncrypt(
      aliceState, 'Hello Bob!', aliceSig.privateKey, 'alice-fp',
    );

    // Envelope should not contain plaintext
    expect(JSON.stringify(envelope)).not.toContain('Hello Bob!');

    const { plaintext, verified, newState: bobNew } = await ratchetDecrypt(
      bobState, envelope, aliceSigPubB64,
    );

    expect(plaintext).toBe('Hello Bob!');
    expect(verified).toBe(true);
  });

  it('full conversation: Alice → Bob → Alice', async () => {
    let { aliceState, bobState, aliceSig, bobSig, aliceSigPubB64, bobSigPubB64 } = await setupAliceAndBob();

    // Alice → Bob (message 1)
    const { envelope: e1, newState: a1 } = await ratchetEncrypt(
      aliceState, 'Msg1', aliceSig.privateKey, 'alice-fp',
    );
    const { plaintext: p1, newState: b1 } = await ratchetDecrypt(bobState, e1, aliceSigPubB64);
    expect(p1).toBe('Msg1');

    // Bob → Alice (message 2)
    const { envelope: e2, newState: b2 } = await ratchetEncrypt(
      b1, 'Msg2', bobSig.privateKey, 'bob-fp',
    );
    const { plaintext: p2, newState: a2 } = await ratchetDecrypt(a1, e2, bobSigPubB64);
    expect(p2).toBe('Msg2');

    // Alice → Bob (message 3)
    const { envelope: e3, newState: a3 } = await ratchetEncrypt(
      a2, 'Msg3', aliceSig.privateKey, 'alice-fp',
    );
    const { plaintext: p3 } = await ratchetDecrypt(b2, e3, aliceSigPubB64);
    expect(p3).toBe('Msg3');
  });

  it('fails decryption with tampered ciphertext', async () => {
    const { aliceState, bobState, aliceSig, aliceSigPubB64 } = await setupAliceAndBob();

    const { envelope } = await ratchetEncrypt(
      aliceState, 'secret', aliceSig.privateKey, 'fp',
    );

    // Tamper ciphertext
    envelope.ct = bufferToBase64(crypto.getRandomValues(new Uint8Array(50)).buffer);

    await expect(ratchetDecrypt(bobState, envelope, aliceSigPubB64)).rejects.toThrow();
  });

  it('serialization round-trip preserves state', async () => {
    const { aliceState } = await setupAliceAndBob();

    const serialized = await serializeRatchetState(aliceState);
    expect(typeof serialized).toBe('string');

    const restored = await deserializeRatchetState(serialized);
    expect(restored.conversationId).toBe('conv-1');
    expect(restored.sendCount).toBe(aliceState.sendCount);
    expect(restored.recvCount).toBe(aliceState.recvCount);
  });

  it('accepts old timestamps (anti-replay enforced by header counters, not ts)', async () => {
    // Per Signal spec: replay is prevented by Double Ratchet header counters
    // (pn/n) + skippedKeys cache, not by wall-clock timestamps. Old messages
    // must remain decryptable after restore (PIN unlock, key backup, sync).
    const { aliceState, bobState, aliceSig } = await setupAliceAndBob();

    const { envelope } = await ratchetEncrypt(
      aliceState, 'msg', aliceSig.privateKey, 'fp',
    );
    envelope.ts = Date.now() - 8 * 24 * 60 * 60 * 1000;

    const { plaintext } = await ratchetDecrypt(bobState, envelope);
    expect(plaintext).toBe('msg');
  });
});
