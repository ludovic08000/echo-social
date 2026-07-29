import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('secure call source policy', () => {
  it('never stores a raw group call key in active_calls', () => {
    const groupSource = source('../groupCall.ts');
    expect(groupSource).not.toMatch(/encrypted_call_key\s*:\s*callKey/);
    expect(groupSource).toContain('startSecureCall');
  });

  it('never treats the group database field as a decrypted key', () => {
    const incomingSource = source('../../../hooks/useIncomingCall.ts');
    expect(incomingSource).not.toMatch(/decryptedCallKey\s*=\s*(encKey|legacyEncryptedKey)/);
    expect(incomingSource).toContain('decryptSecureCallKeyForCurrentDevice');
  });

  it('ships an atomic per-device call-key migration', () => {
    const migration = source('../../../../supabase/migrations/20260729233000_secure_call_device_key_fanout.sql');
    expect(migration).toContain('create table if not exists public.call_device_key_copies');
    expect(migration).toContain('create_secure_call_v1');
    expect(migration).toContain('GROUP_CALL_RAW_KEY_FORBIDDEN');
    expect(migration).toContain('encrypted_call_key\n  ) values');
  });
});
