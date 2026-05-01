import { describe, it } from 'vitest';
import {
  establishDeviceSession,
  ratchetEncrypt,
  ratchetDecrypt,
  clearAllDeviceSessions,
  RATCHET_PREFIX_V4,
} from '@/lib/crypto/deviceRatchet';

describe('debug', () => {
  it('inspect', async () => {
    await clearAllDeviceSessions();
    const ss = new Uint8Array(32); for (let i=0;i<32;i++) ss[i]=i;
    const kp = await crypto.subtle.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pubB64 = btoa(String.fromCharCode(...new Uint8Array(raw)));

    await establishDeviceSession('A','dA','B','dB', ss.buffer, undefined,
      { isInitiator: true, peerInitialDhPubB64: pubB64 });
    const ct = await ratchetEncrypt('A','dA','B','dB','hi');
    console.log('CT:', ct?.slice(0,80));
    console.log('CT parts:', ct?.split('.').length);

    await establishDeviceSession('B','dB','A','dA', ss.buffer, undefined,
      { isInitiator: false, selfInitialDhPrivJwk: jwk, selfInitialDhPubB64: pubB64 });
    const pt = await ratchetDecrypt('B','dB', ct!);
    console.log('PT result:', pt);
  });
});
