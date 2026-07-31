import { describe, expect, it } from 'vitest';
import {
  createAegisSessionId,
  parseAegisInitialPayload,
  parseAegisRatchetPayload,
} from '../aegisDeviceWire';
import {
  VALID_AEGIS_SESSION_ID,
  VALID_INIT_COPY,
  VALID_RATCHET_COPY,
} from '@/test/aegisWireFixtures';

describe('canonical Aegis device wire', () => {
  it('creates a 128-bit session identifier in the only accepted shape', () => {
    const sessionId = createAegisSessionId();
    expect(sessionId).toMatch(/^s_[A-Za-z0-9_-]{22}$/);
    expect(sessionId).not.toBe(VALID_AEGIS_SESSION_ID);
  });

  it('strictly parses the Ratchet and initial envelopes', () => {
    expect(parseAegisRatchetPayload(VALID_RATCHET_COPY)?.sessionId).toBe(VALID_AEGIS_SESSION_ID);
    expect(parseAegisInitialPayload(VALID_INIT_COPY)?.sessionId).toBe(VALID_AEGIS_SESSION_ID);
  });

  it('rejects short keys, non-canonical base64, oversized counters and arbitrary sessions', () => {
    expect(parseAegisRatchetPayload(VALID_RATCHET_COPY.replace(VALID_AEGIS_SESSION_ID, 'session'))).toBeNull();
    expect(parseAegisRatchetPayload(VALID_RATCHET_COPY.replace('.0.0.', '.2147483648.0.'))).toBeNull();
    expect(parseAegisRatchetPayload(VALID_RATCHET_COPY.replace(/\.[^.]+$/, '.AA=='))).toBeNull();
    expect(parseAegisInitialPayload(VALID_INIT_COPY.replace('.17.23.', '.0.23.'))).toBeNull();
  });
});
