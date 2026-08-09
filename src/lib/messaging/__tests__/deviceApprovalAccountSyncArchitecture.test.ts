import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const outbound = readFileSync('src/lib/messaging/aegisOutboundEngine.ts', 'utf8');

describe('device approval account synchronization architecture', () => {
  it('blocks the encrypted outbound engine before device and Ratchet work', () => {
    const synchronizationGate = outbound.indexOf('await waitForAccountSynchronization');
    const deviceReadiness = outbound.indexOf('await ensureAegisDeviceReady');
    const durableOutbox = outbound.indexOf("trace('OUTBOX_DURABLE'");

    expect(synchronizationGate).toBeGreaterThan(-1);
    expect(deviceReadiness).toBeGreaterThan(synchronizationGate);
    expect(durableOutbox).toBeGreaterThan(synchronizationGate);
  });
});
