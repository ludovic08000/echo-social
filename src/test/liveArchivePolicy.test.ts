// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { liveDeadline, LIVE_MAX_DURATION_MS, LIVE_ARCHIVE_RETENTION_MS, liveArchiveKey } from '../../supabase/functions/_shared/live-policy';

const owner='11111111-1111-4111-8111-111111111111';
const base='https://media.example.test';
describe('live limits and archive deletion scope', () => {
  it('ends four hours after the server start, independently of the browser clock lifecycle', () => {
    expect(LIVE_MAX_DURATION_MS).toBe(14_400_000);
    expect(liveDeadline('2026-11-04T12:00:00Z')).toBe(Date.parse('2026-11-04T16:00:00Z'));
    expect(liveDeadline(null)).toBe(0);
    expect(liveDeadline('not a date')).toBe(0);
    expect(LIVE_ARCHIVE_RETENTION_MS).toBe(30*86400_000);
  });
  it('accepts only an archive belonging to the full account UUID', () => {
    expect(liveArchiveKey(`${base}/${owner}/lives/1790000000000.webm`,base,owner)).toBe(`${owner}/lives/1790000000000.webm`);
  });
  it.each([
    `${base}/22222222-2222-4222-8222-222222222222/lives/1790000000000.webm`,
    `${base}/${owner}/voice/1790000000000.webm`,
    `${base}/legacy-11111111/lives/1790000000000.webm`,
    `${base}/${owner}/lives/1790000000000.webm.enc`,
    `${base}/${owner}/lives/1790000000000.webm?download=1`,
    `https://foreign.example.test/${owner}/lives/1790000000000.webm`,
    `${base}/${owner}/lives/../documents/1790000000000.webm`,
  ])('rejects a foreign, legacy, encrypted or ambiguous asset: %s', raw => {
    expect(()=>liveArchiveKey(raw,base,owner)).toThrow();
  });
});
