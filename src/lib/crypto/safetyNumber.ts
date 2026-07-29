import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';

const SAFETY_DOMAIN = 'forsure-aegis-safety-number-v1';
const FINGERPRINT_RE = /^[0-9a-f ]{32,160}$/i;

function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function canonicalPair(myFingerprint: string, peerFingerprint: string): [string, string] {
  const mine = normalizeFingerprint(myFingerprint);
  const peer = normalizeFingerprint(peerFingerprint);
  if (!FINGERPRINT_RE.test(mine) || !FINGERPRINT_RE.test(peer)) {
    throw new Error('SAFETY_NUMBER_INVALID_FINGERPRINT');
  }
  return [mine, peer].sort() as [string, string];
}

/**
 * Aegis safety numbers are domain-separated SHA-512 digests rendered as sixty
 * decimal digits. This is not Signal's wire format, but it has the same core
 * property: both participants derive the same value only from the two stable
 * account identity fingerprints.
 */
export async function deriveAegisSafetyNumber(
  myFingerprint: string,
  peerFingerprint: string,
): Promise<string> {
  const [fpA, fpB] = canonicalPair(myFingerprint, peerFingerprint);
  const input = new TextEncoder().encode(JSON.stringify({
    protocol: SAFETY_DOMAIN,
    version: 1,
    fpA,
    fpB,
  }));
  const digest = new Uint8Array(await hardCrypto.digest('SHA-512', input));
  const groups: string[] = [];
  for (let offset = 0; offset < 60; offset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      value = (value * 256 + digest[offset + index]) % 100000;
    }
    groups.push(String(value).padStart(5, '0'));
  }
  return groups.join(' ');
}

export function buildAegisSafetyQrPayload(input: {
  myFingerprint: string;
  peerFingerprint: string;
  safetyNumber: string;
}): string {
  const [fpA, fpB] = canonicalPair(input.myFingerprint, input.peerFingerprint);
  if (!/^(?:\d{5} ){11}\d{5}$/.test(input.safetyNumber)) {
    throw new Error('SAFETY_NUMBER_INVALID_DISPLAY');
  }
  return JSON.stringify({
    protocol: SAFETY_DOMAIN,
    version: 1,
    fpA,
    fpB,
    safetyNumber: input.safetyNumber,
  });
}

export const __test__ = { canonicalPair, domain: SAFETY_DOMAIN };
