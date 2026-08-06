import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
}));

function queryResult(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error })),
  };
  return query;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mocks.from,
    rpc: vi.fn(),
  },
}));

vi.mock('@/lib/crypto/keyManagerSafe', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
}));

vi.mock('@/lib/crypto/deviceEnrollmentPossession', () => ({
  signDeviceEnrollmentPossession: vi.fn(),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentPlatform: () => 'web',
}));

import { readActiveAccountFingerprint } from '@/lib/crypto/serverDeviceEnrollment';

const userId = '11111111-1111-4111-8111-111111111111';
const serverFingerprint = 'AA11 BB22 CC33 DD44 EE55 FF66 7788 9900 AABB CCDD';
const localFingerprint = '0011 2233 4455 6677 8899 AABB CCDD EEFF 0011 2233';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('account fingerprint bootstrap continuity', () => {
  it('uses the active server fingerprint without touching local bootstrap', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'user_public_keys') return queryResult({ fingerprint: serverFingerprint });
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(readActiveAccountFingerprint(userId)).resolves.toBe(serverFingerprint);
    expect(mocks.getOrCreateIdentityKeys).not.toHaveBeenCalled();
  });

  it('creates the stable account identity only for a genuinely empty account', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'user_public_keys') return queryResult(null);
      if (table === 'user_devices') return queryResult(null);
      throw new Error(`Unexpected table ${table}`);
    });
    mocks.getOrCreateIdentityKeys.mockResolvedValue({ fingerprint: localFingerprint });

    await expect(readActiveAccountFingerprint(userId)).resolves.toBe(localFingerprint);
    expect(mocks.getOrCreateIdentityKeys).toHaveBeenCalledOnce();
    expect(mocks.getOrCreateIdentityKeys).toHaveBeenCalledWith(userId);
  });

  it('blocks implicit root-key replacement when any device history already exists', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'user_public_keys') return queryResult(null);
      if (table === 'user_devices') return queryResult({ device_id: `dev_${'a'.repeat(32)}` });
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(readActiveAccountFingerprint(userId))
      .rejects.toThrow('ACCOUNT_IDENTITY_BOOTSTRAP_REQUIRES_EXPLICIT_MIGRATION');
    expect(mocks.getOrCreateIdentityKeys).not.toHaveBeenCalled();
  });

  it('fails closed when device-history inspection is unavailable', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'user_public_keys') return queryResult(null);
      if (table === 'user_devices') {
        return queryResult(null, { message: 'temporary database failure' });
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(readActiveAccountFingerprint(userId))
      .rejects.toThrow('ACCOUNT_DEVICE_HISTORY_LOOKUP_FAILED:temporary database failure');
    expect(mocks.getOrCreateIdentityKeys).not.toHaveBeenCalled();
  });
});
