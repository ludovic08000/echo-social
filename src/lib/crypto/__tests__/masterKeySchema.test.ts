import { describe, expect, it } from 'vitest';
import {
  AEGIS_MASTER_KEY_SCHEMA,
  isCurrentMasterKeySchema,
  masterKeyAADLabel,
} from '@/lib/crypto/masterKeySchema';

describe('single Aegis Master Key schema', () => {
  it('accepts only the current schema', () => {
    expect(isCurrentMasterKeySchema(AEGIS_MASTER_KEY_SCHEMA)).toBe(true);
    for (const rejected of [undefined, null, '7', 0, 1, 2, 3, 4, 5, 6, 8, 100]) {
      expect(isCurrentMasterKeySchema(rejected)).toBe(false);
    }
  });

  it('binds authenticated data to user, purpose and schema', () => {
    const account = masterKeyAADLabel('user-a', 'account');
    expect(account).not.toBe(masterKeyAADLabel('user-b', 'account'));
    expect(account).not.toBe(masterKeyAADLabel('user-a', 'recovery'));
    expect(account).toContain(`schema-${AEGIS_MASTER_KEY_SCHEMA}`);
  });
});
