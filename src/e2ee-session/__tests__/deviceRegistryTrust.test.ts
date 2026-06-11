/**
 * Lot A1 — Trust gate around the device registry.
 *
 * Verifies that `listDevicesForUser`:
 *   1) returns ONLY signed devices when the L4 signed list is non-empty
 *      (rogue devices injected via the raw RPC must NOT leak through).
 *   2) falls back to the legacy raw RPC only when the signed list is empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'self-device',
  isDeviceIdTemporary: () => false,
}));

const fetchVerifiedMock = vi.fn();
vi.mock('@/lib/crypto/signedDeviceList', () => ({
  fetchVerifiedDeviceList: (...args: unknown[]) => fetchVerifiedMock(...args),
}));

// Hygiene filter calls peekDeviceSignedPrekey; in unit-test mode we treat
// every candidate as having a valid SPK so the trust gate logic is what's
// actually under test.
vi.mock('@/lib/crypto/x3dh', () => ({
  peekDeviceSignedPrekey: vi.fn(async () => ({ spkId: 1, spkPub: 'PUB', spkSig: 'SIG' })),
}));

import { supabase } from '@/integrations/supabase/client';
import { listDevicesForUser } from '../deviceRegistry';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Lot A1 — trust-gated device list', () => {
  it('returns only signed devices and ignores rogue raw entries', async () => {
    fetchVerifiedMock.mockResolvedValue({
      signedListPresent: true,
      trusted: [{ deviceId: 'dev-good', devicePublicKey: 'PUB_GOOD' }],
      verifications: [{ deviceId: 'dev-good', ok: true, reason: 'VALID' }],
    });
    // Even if the raw RPC has a rogue entry, the trust path wins.
    (supabase.rpc as any).mockResolvedValue({
      data: [
        { device_id: 'dev-good', device_public_key: 'PUB_GOOD' },
        { device_id: 'dev-rogue', device_public_key: 'PUB_ROGUE' },
      ],
      error: null,
    });

    const out = await listDevicesForUser('user-123');
    expect(out.map(d => d.deviceId)).toEqual(['dev-good']);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('falls back to legacy RPC when no signed entry exists', async () => {
    fetchVerifiedMock.mockResolvedValue({
      signedListPresent: false,
      trusted: [],
      verifications: [],
    }); // L4 not yet adopted
    (supabase.rpc as any).mockResolvedValue({
      data: [{ device_id: 'dev-legacy', device_public_key: 'PUB_LEGACY' }],
      error: null,
    });
    const out = await listDevicesForUser('user-456');
    expect(out.map(d => d.deviceId)).toEqual(['dev-legacy']);
    expect(supabase.rpc).toHaveBeenCalledWith('list_active_devices_for_user', { p_user_id: 'user-456' });
  });

  it('returns [] when both paths fail', async () => {
    fetchVerifiedMock.mockRejectedValue(new Error('rpc down'));
    (supabase.rpc as any).mockResolvedValue({ data: null, error: new Error('also down') });
    const out = await listDevicesForUser('user-789');
    expect(out).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalledWith('list_active_devices_for_user', expect.anything());
  });

  it('strips devices with empty public keys from the trusted set', async () => {
    fetchVerifiedMock.mockResolvedValue({
      signedListPresent: true,
      trusted: [
        { deviceId: 'dev-a', devicePublicKey: 'PUB_A' },
        { deviceId: 'dev-b', devicePublicKey: '' },
      ],
      verifications: [
        { deviceId: 'dev-a', ok: true, reason: 'VALID' },
        { deviceId: 'dev-b', ok: true, reason: 'VALID' },
      ],
    });
    const out = await listDevicesForUser('user-x');
    expect(out.map(d => d.deviceId)).toEqual(['dev-a']);
  });

  it('does not downgrade to raw RPC when a signed list exists but verifies to zero trusted devices', async () => {
    fetchVerifiedMock.mockResolvedValue({
      signedListPresent: true,
      trusted: [],
      verifications: [{ deviceId: 'dev-bad', ok: false, reason: 'BAD_SIGNATURE' }],
    });
    (supabase.rpc as any).mockResolvedValue({
      data: [{ device_id: 'dev-rogue', device_public_key: 'PUB_ROGUE' }],
      error: null,
    });

    const out = await listDevicesForUser('user-signed-bad');

    expect(out).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalledWith('list_active_devices_for_user', expect.anything());
  });
});
