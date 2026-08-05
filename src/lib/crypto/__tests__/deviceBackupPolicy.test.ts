import { describe, expect, it } from 'vitest';
import {
  discardLegacyDeviceIdFromBackup,
  LEGACY_DEVICE_ID_BACKUP_KEY,
} from '../deviceBackupPolicy';

describe('device backup policy', () => {
  it('removes a legacy Windows DeviceID before an iOS restore', () => {
    const backup: Record<string, unknown> = {
      [LEGACY_DEVICE_ID_BACKUP_KEY]: 'windows-device-routing-id',
      'e2ee:identity-keys': [{ id: 'account-id' }],
      _meta: { scope: 'device-keychain' },
    };

    expect(discardLegacyDeviceIdFromBackup(backup)).toBe(true);
    expect(backup).not.toHaveProperty(LEGACY_DEVICE_ID_BACKUP_KEY);
    expect(backup['e2ee:identity-keys']).toEqual([{ id: 'account-id' }]);
  });

  it('leaves a modern backup unchanged', () => {
    const backup: Record<string, unknown> = {
      'e2ee:identity-keys': [{ id: 'account-id' }],
    };

    expect(discardLegacyDeviceIdFromBackup(backup)).toBe(false);
    expect(backup).toEqual({
      'e2ee:identity-keys': [{ id: 'account-id' }],
    });
  });
});
