import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fanout = readFileSync('src/lib/messaging/multiDeviceFanout.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260805164500_require_active_spk_for_device_routing.sql',
  'utf8',
);

describe('fanout exact device coverage contract', () => {
  it('builds exact coverage only over the canonical routable snapshot', () => {
    expect(migration).toContain('exists (');
    expect(migration).toContain('from public.device_signed_prekeys spk');
    expect(fanout).toContain('routeRefreshAttempt = 0');
    expect(fanout).toContain('return buildFanoutCopies(input, 1)');
  });

  it('permits only one route refresh then fails closed on partial coverage', () => {
    expect(fanout).toContain('if (routeRefreshAttempt === 0)');
    expect(fanout).toContain('FANOUT_EXACT_COVERAGE');
    expect(fanout).toContain('requestOmittedRouteRepair');
    // Fail-closed conservé: zéro capsule chiffrable => refus, jamais de clair.
    expect(fanout).toContain("throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE')");
    expect(fanout).not.toContain('plaintextFallback');
  });
});
