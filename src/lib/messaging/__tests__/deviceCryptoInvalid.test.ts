import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWN_INVALID_DEVICE_IDS,
  getDeviceCryptoInvalid,
  isInvalidDeviceId,
  markDeviceCryptoInvalid,
} from '../deviceCryptoInvalid';

const REQUIRED_INVALID_DEVICE_IDS = [
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
] as const;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
});

describe('device crypto invalid cache', () => {
  it('contains every known revoked device id', () => {
    expect(KNOWN_INVALID_DEVICE_IDS).toEqual(expect.arrayContaining([...REQUIRED_INVALID_DEVICE_IDS]));
    for (const deviceId of REQUIRED_INVALID_DEVICE_IDS) {
      expect(isInvalidDeviceId(deviceId)).toBe(true);
      expect(getDeviceCryptoInvalid('user-1', deviceId)).toMatchObject({
        deviceId,
        reason: 'known_invalid_device_quarantine',
      });
    }
  });

  it('stores newly detected invalid devices in the local quarantine cache', () => {
    markDeviceCryptoInvalid('user-1', 'fresh-invalid-device', 'invalid_spk_signature', 60_000);

    expect(getDeviceCryptoInvalid('user-1', 'fresh-invalid-device')).toMatchObject({
      userId: 'user-1',
      deviceId: 'fresh-invalid-device',
      reason: 'invalid_spk_signature',
    });
    expect(isInvalidDeviceId('fresh-invalid-device')).toBe(true);
  });

  it('keeps revoked 84aaa devices out of recovery lookups', () => {
    expect(getDeviceCryptoInvalid('user-1', '84aaa52143235807214bf3aa161dd03a')).not.toBeNull();
  });
});
