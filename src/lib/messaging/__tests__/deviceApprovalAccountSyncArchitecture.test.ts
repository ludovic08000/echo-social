import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registration = readFileSync('src/hooks/useDeviceRegistration.ts', 'utf8');
const outbound = readFileSync('src/lib/messaging/aegisOutboundEngine.ts', 'utf8');

describe('device approval account synchronization architecture', () => {
  it('forces inbox and application-query refresh before announcing device readiness', () => {
    const synchronization = registration.indexOf('await beginAccountSynchronization');
    const approvedEvent = registration.indexOf("new CustomEvent('forsure:e2ee-device-approved'");
    const routeReadyEvent = registration.indexOf("new CustomEvent('forsure:aegis-route-ready'");

    expect(synchronization).toBeGreaterThan(-1);
    expect(registration).toContain('await syncAegisDeviceInbox(user.id)');
    expect(registration).toContain("await queryClient.invalidateQueries({ refetchType: 'none' })");
    expect(registration).toContain("await queryClient.refetchQueries({ type: 'active' })");
    expect(approvedEvent).toBeGreaterThan(synchronization);
    expect(routeReadyEvent).toBeGreaterThan(synchronization);
  });

  it('blocks the encrypted outbound engine before device and Ratchet work', () => {
    const synchronizationGate = outbound.indexOf('await waitForAccountSynchronization');
    const deviceReadiness = outbound.indexOf('await ensureAegisDeviceReady');
    const durableOutbox = outbound.indexOf("trace('OUTBOX_DURABLE'");

    expect(synchronizationGate).toBeGreaterThan(-1);
    expect(deviceReadiness).toBeGreaterThan(synchronizationGate);
    expect(durableOutbox).toBeGreaterThan(synchronizationGate);
  });
});
