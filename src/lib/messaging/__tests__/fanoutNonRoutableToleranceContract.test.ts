import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fanout = readFileSync('src/lib/messaging/multiDeviceFanout.ts', 'utf8');
const routeCutover = readFileSync(
  'supabase/migrations/20260915180000_require_libsignal_bundle_for_route.sql',
  'utf8',
);

describe('fanout exact Libsignal device coverage contract', () => {
  it('builds exact coverage only over routes backed by a matching Libsignal bundle', () => {
    expect(routeCutover).toContain('from public.device_libsignal_prekey_bundles bundle');
    expect(routeCutover).toContain('bundle.device_number = device.libsignal_device_number');
    expect(routeCutover).not.toContain('device_signed_prekeys');
    expect(fanout).toContain('routeRefreshAttempt = 0');
    expect(fanout).toContain('return buildFanoutCopies(input, 1)');
  });

  it('permits one route refresh then fails closed on partial coverage', () => {
    expect(fanout).toContain('if (routeRefreshAttempt === 0)');
    expect(fanout).toContain('FANOUT_EXACT_COVERAGE');
    expect(fanout).toContain('requestOmittedRouteRepair');
    expect(fanout).toContain("throw new Error('E2EE_DEVICE_COPIES_UNAVAILABLE')");
    expect(fanout).not.toContain('plaintextFallback');
  });
});
