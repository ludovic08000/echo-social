import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Aegis stage 3 schema diagnostic', () => {
  it('points server repair at the verified, challenge-bound device flow', () => {
    const enrollment = readFileSync(
      resolve(process.cwd(), 'src/lib/crypto/serverDeviceEnrollment.ts'),
      'utf8',
    );
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'supabase/migrations/20260806130000_bind_device_possession_to_exact_challenge.sql',
      ),
      'utf8',
    );

    expect(enrollment).toContain('beginServerAssignedDeviceEnrollment');
    expect(enrollment).toContain('completeServerAssignedDeviceEnrollment');
    expect(enrollment).not.toContain('register_user_device_safe');
    expect(migration).toContain('DEVICE_POSSESSION_PROOF_REQUIRED');
    expect(migration).toContain('approval_challenge_id');
    expect(migration).not.toContain('20260728100000_sesame_per_device_identity.sql');
  });
});
