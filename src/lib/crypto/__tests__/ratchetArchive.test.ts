/**
 * Session archive tests — recovery of old-key messages after a key change.
 */
import { describe, it, expect } from 'vitest';
import {
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
} from '../ratchet';
import { bufferToBase64 } from '../utils';
import {
  capArchive,
  archiveRatchetState,
  loadArchivedRatchetStates,
  tryDecryptWithArchivedSessions,
  clearArchivedRatchetStates,
  MAX_ARCHIVED_SESSIONS,
} from '../ratchetArchive';

/* eslint-disable @typescript-eslint/no-explicit-any -- X25519/Ed25519 are not in lib.dom types */
const KX = { name: 'X25519' } as any;
const SIG = { name: 'Ed25519' } as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function setupAliceAndBob(convId: string) {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(64)).buffer;
  const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;

  const aliceIK = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const bobIK = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const aliceIKB64 = bufferToBase64(await crypto.subtle.exportKey('raw', aliceIK.publicKey));
  const bobIKB64 = bufferToBase64(await crypto.subtle.exportKey('raw', bobIK.publicKey));

  const aliceState = await initRatchetAsInitiator(convId, sharedSecret, bobDhPair.publicKey, {
    myIdentityKeyB64: aliceIKB64,
    peerIdentityKeyB64: bobIKB64,
  });
  const bobState = await initRatchetAsResponder(convId, sharedSecret, bobDhPair, {
    myIdentityKeyB64: bobIKB64,
    peerIdentityKeyB64: aliceIKB64,
  });

  const aliceSig = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const aliceSigPubB64 = bufferToBase64(await crypto.subtle.exportKey('raw', aliceSig.publicKey));

  return { aliceState, bobState, aliceSig, aliceSigPubB64 };
}

describe('capArchive', () => {
  const e = (n: number) => ({ data: `s${n}`, archivedAt: n });

  it('returns the list unchanged when under the cap', () => {
    const list = [e(1), e(2), e(3)];
    expect(capArchive(list, 5).map(x => x.archivedAt)).toEqual([1, 2, 3]);
  });

  it('keeps only the newest `max` entries (drops oldest)', () => {
    const list = [e(1), e(2), e(3), e(4), e(5)];
    expect(capArchive(list, 3).map(x => x.archivedAt)).toEqual([3, 4, 5]);
  });

  it('returns a copy, not the same reference', () => {
    const list = [e(1)];
    expect(capArchive(list, 5)).not.toBe(list);
  });
});

describe('ratchet session archive (IndexedDB round-trip)', () => {
  it('archives and reloads a ratchet state', async () => {
    const convId = 'conv-archive-roundtrip';
    await clearArchivedRatchetStates(convId);
    const { bobState } = await setupAliceAndBob(convId);

    await archiveRatchetState(convId, bobState);
    const loaded = await loadArchivedRatchetStates(convId);

    expect(loaded.length).toBe(1);
    expect(loaded[0].conversationId).toBe(convId);
  });

  it('caps stored archives at MAX_ARCHIVED_SESSIONS', async () => {
    const convId = 'conv-archive-cap';
    await clearArchivedRatchetStates(convId);
    const { bobState } = await setupAliceAndBob(convId);

    for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 5; i++) {
      await archiveRatchetState(convId, bobState);
    }
    const loaded = await loadArchivedRatchetStates(convId);
    expect(loaded.length).toBe(MAX_ARCHIVED_SESSIONS);
  });

  it('recovers a message from an archived session after the live ratchet is reset', async () => {
    const convId = 'conv-archive-recovery';
    await clearArchivedRatchetStates(convId);
    const { aliceState, bobState, aliceSig, aliceSigPubB64 } = await setupAliceAndBob(convId);

    // Alice encrypts a message under the CURRENT (soon-to-be-old) session.
    const { envelope } = await ratchetEncrypt(aliceState, 'message under the old key', aliceSig.privateKey, 'alice-fp');

    // Simulate a key change: Bob archives his current session, then his live
    // ratchet is destroyed (as the fingerprint-change handler does).
    await archiveRatchetState(convId, bobState);
    // (live ratchet is now gone — Bob has no current session for this envelope)

    // Recovery: the archived session must still decrypt Alice's old-key message.
    const recovered = await tryDecryptWithArchivedSessions(convId, envelope, aliceSigPubB64);
    expect(recovered).not.toBeNull();
    expect(recovered?.plaintext).toBe('message under the old key');
    expect(recovered?.verified).toBe(true);
  });

  it('returns null when no archived session can decrypt the envelope', async () => {
    const convId = 'conv-archive-miss';
    await clearArchivedRatchetStates(convId);
    const { aliceSig } = await setupAliceAndBob(convId);

    // A fresh unrelated session archived under this conversation.
    const other = await setupAliceAndBob('conv-other');
    await archiveRatchetState(convId, other.bobState);

    // Alice's envelope belongs to a DIFFERENT session — archived one can't read it.
    const { envelope } = await ratchetEncrypt(
      (await setupAliceAndBob('conv-x')).aliceState,
      'unrelated',
      aliceSig.privateKey,
      'alice-fp',
    );
    const recovered = await tryDecryptWithArchivedSessions(convId, envelope, other.aliceSigPubB64);
    expect(recovered).toBeNull();
  });
});
