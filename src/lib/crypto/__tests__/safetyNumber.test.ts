import { describe, expect, it } from 'vitest';
import {
  buildAegisSafetyQrPayload,
  deriveAegisSafetyNumber,
} from '@/lib/crypto/safetyNumber';

const A = 'AA'.repeat(40);
const B = 'BB'.repeat(40);

describe('Aegis safety number', () => {
  it('is symmetric, deterministic and sixty decimal digits', async () => {
    const ab = await deriveAegisSafetyNumber(A, B);
    const ba = await deriveAegisSafetyNumber(B, A);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^(?:\d{5} ){11}\d{5}$/);
    expect(ab.replace(/ /g, '')).toHaveLength(60);
  });

  it('binds both full fingerprints in the QR payload', async () => {
    const safetyNumber = await deriveAegisSafetyNumber(A, B);
    const payload = JSON.parse(buildAegisSafetyQrPayload({
      myFingerprint: A,
      peerFingerprint: B,
      safetyNumber,
    }));
    expect(payload.fpA).toBe(A);
    expect(payload.fpB).toBe(B);
    expect(payload.safetyNumber).toBe(safetyNumber);
  });
});
