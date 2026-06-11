/**
 * v4 Strict Outbound — anti-downgrade contract
 *
 * Garde-fou d'intégration : toute enveloppe sortante DOIT être v4 (Signal
 * Double Ratchet rev.4 §3.4) et l'absence d'identity keys côté ratchet DOIT
 * faire échouer l'envoi avec `E_RATCHET_V4_REQUIRED` plutôt que de silencieusement
 * retomber sur v2/v3.
 *
 * Si ce test casse, c'est qu'un downgrade a été réintroduit — refuser le merge.
 */
import { describe, it, expect } from 'vitest';
import {
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../ratchet';
import { PROTOCOL_VERSION } from '../constants';
import { bufferToBase64 } from '../utils';

const KX = { name: 'X25519' } as any;
const SIG = { name: 'Ed25519' } as any;

async function makeSharedSecret(): Promise<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(64)).buffer;
}

async function makeIdentityKeyB64(): Promise<string> {
  const pair = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  return bufferToBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
}

describe('v4 Strict Outbound — anti-downgrade contract', () => {
  it('PROTOCOL_VERSION constant is pinned to 4', () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it('emits a v4 envelope when identity keys are present', async () => {
    const sharedSecret = await makeSharedSecret();
    const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
    const aliceIK = await makeIdentityKeyB64();
    const bobIK = await makeIdentityKeyB64();

    const aliceState = await initRatchetAsInitiator('conv-v4', sharedSecret, bobDhPair.publicKey, {
      myIdentityKeyB64: aliceIK,
      peerIdentityKeyB64: bobIK,
    });

    const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;

    const { envelope } = await ratchetEncrypt(aliceState, 'hello v4', aliceSig.privateKey, 'fp');

    expect(envelope.v).toBe(4);
    expect(envelope.v).toBe(PROTOCOL_VERSION);
    // header fields are present and bound via AAD
    expect(typeof envelope.hdr.dh).toBe('string');
    expect(typeof envelope.hdr.n).toBe('number');
    expect(typeof envelope.hdr.pn).toBe('number');
  });

  it('REFUSES to encrypt when myIdentityKeyB64 is missing', async () => {
    const sharedSecret = await makeSharedSecret();
    const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
    const bobIK = await makeIdentityKeyB64();

    const aliceState = await initRatchetAsInitiator('conv-v4', sharedSecret, bobDhPair.publicKey, {
      myIdentityKeyB64: undefined as unknown as string,
      peerIdentityKeyB64: bobIK,
    });

    const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;

    await expect(
      ratchetEncrypt(aliceState, 'should not emit', aliceSig.privateKey, 'fp')
    ).rejects.toThrow(/E_RATCHET_V4_REQUIRED/);
  });

  it('REFUSES to encrypt when peerIdentityKeyB64 is missing', async () => {
    const sharedSecret = await makeSharedSecret();
    const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
    const aliceIK = await makeIdentityKeyB64();

    const aliceState = await initRatchetAsInitiator('conv-v4', sharedSecret, bobDhPair.publicKey, {
      myIdentityKeyB64: aliceIK,
      peerIdentityKeyB64: undefined as unknown as string,
    });

    const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;

    await expect(
      ratchetEncrypt(aliceState, 'should not emit', aliceSig.privateKey, 'fp')
    ).rejects.toThrow(/E_RATCHET_V4_REQUIRED/);
  });

  it('REFUSES to encrypt when role is missing (no canonical AAD ordering possible)', async () => {
    const sharedSecret = await makeSharedSecret();
    const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
    const aliceIK = await makeIdentityKeyB64();
    const bobIK = await makeIdentityKeyB64();

    const aliceState = await initRatchetAsInitiator('conv-v4', sharedSecret, bobDhPair.publicKey, {
      myIdentityKeyB64: aliceIK,
      peerIdentityKeyB64: bobIK,
    });

    // Simulate a corrupted state restored from disk (legacy v2 state).
    (aliceState as any).role = undefined;

    const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;

    await expect(
      ratchetEncrypt(aliceState, 'should not emit', aliceSig.privateKey, 'fp')
    ).rejects.toThrow(/E_RATCHET_V4_REQUIRED/);
  });

  it('round-trip: v4 envelope decrypts cleanly between Alice and Bob', async () => {
    const sharedSecret = await makeSharedSecret();
    const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
    const aliceIK = await makeIdentityKeyB64();
    const bobIK = await makeIdentityKeyB64();

    const aliceState = await initRatchetAsInitiator('conv-v4', sharedSecret, bobDhPair.publicKey, {
      myIdentityKeyB64: aliceIK,
      peerIdentityKeyB64: bobIK,
    });
    const bobState = await initRatchetAsResponder('conv-v4', sharedSecret, bobDhPair, {
      myIdentityKeyB64: bobIK,
      peerIdentityKeyB64: aliceIK,
    });

    const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
    const aliceSigPubB64 = bufferToBase64(await crypto.subtle.exportKey('raw', aliceSig.publicKey));

    const { envelope } = await ratchetEncrypt(aliceState, 'ping', aliceSig.privateKey, 'fp');
    expect(envelope.v).toBe(4);

    const { plaintext, verified } = await ratchetDecrypt(bobState, envelope, aliceSigPubB64);
    expect(plaintext).toBe('ping');
    expect(verified).toBe(true);
  });

  it('tampered header is rejected (header is bound to ciphertext via AAD)', async () => {
    const sharedSecret = await makeSharedSecret();
    const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
    const aliceIK = await makeIdentityKeyB64();
    const bobIK = await makeIdentityKeyB64();

    const aliceState = await initRatchetAsInitiator('conv-v4', sharedSecret, bobDhPair.publicKey, {
      myIdentityKeyB64: aliceIK,
      peerIdentityKeyB64: bobIK,
    });
    const bobState = await initRatchetAsResponder('conv-v4', sharedSecret, bobDhPair, {
      myIdentityKeyB64: bobIK,
      peerIdentityKeyB64: aliceIK,
    });

    const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;

    const { envelope } = await ratchetEncrypt(aliceState, 'secret', aliceSig.privateKey, 'fp');
    // Flip the message counter — header is part of v4 AAD so AEAD MUST fail.
    const tampered = { ...envelope, hdr: { ...envelope.hdr, n: envelope.hdr.n + 7 } };

    await expect(ratchetDecrypt(bobState, tampered)).rejects.toThrow();
  });
});
