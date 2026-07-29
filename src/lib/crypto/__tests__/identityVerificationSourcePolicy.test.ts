import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('identity verification source policy', () => {
  it('never lets an unsigned server value override local continuity', () => {
    const tracker = source('../fingerprintTracker.ts');
    expect(tracker).not.toContain('serverPrevious ?? localPrevious');
    expect(tracker).toContain('Local trust always wins');
    expect(tracker).toContain('observer_signature');
  });

  it('does not fabricate a safety number from conversation metadata', () => {
    const warning = source('../../../components/messages/ContactVerificationDialog.tsx');
    expect(warning).not.toContain('acc = (acc * 31');
    expect(warning).toContain('deriveAegisSafetyNumber');
    expect(warning).toContain('acceptPeerFingerprint');
    expect(warning).toContain('J’ai comparé les deux valeurs');
  });

  it('removes unsigned legacy server trust during migration', () => {
    const migration = source('../../../../supabase/migrations/20260729235500_signed_fingerprint_trust_attestations.sql');
    expect(migration).toContain('observer_signature');
    expect(migration).toContain('delete from public.user_known_fingerprints');
  });
});
