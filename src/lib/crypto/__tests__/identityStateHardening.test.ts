/**
 * Durcissement de l'automate d'identité : les états doivent rester dans la
 * liste autorisée et aucune décision ne doit dépendre d'un compteur ou d'un délai.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tables: Record<string, { data: unknown; error: unknown }> = {};

vi.mock('@/integrations/supabase/client', () => {
  const build = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.eq = self;
    chain.limit = () => Promise.resolve(tables[table] ?? { data: [], error: null });
    chain.maybeSingle = () => Promise.resolve(tables[table] ?? { data: null, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve);
    return chain;
  };
  return { supabase: { from: (table: string) => build(table.replace(/ as never$/, '')) } };
});

vi.mock('@/lib/crypto/accountKeyBackup', () => ({ hasLocalKeys: vi.fn(async () => false) }));
vi.mock('@/lib/crypto/aegisRecoveryVault', () => ({ hasAegisRecoveryVault: vi.fn(async () => false) }));
vi.mock('@/lib/crypto/keyManager', () => ({
  loadIdentityKeys: vi.fn(async () => null),
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

import { inspectAccountCryptoState } from '../accountCryptoState';

const USER = '00000000-0000-4000-8000-000000000001';
const ALLOWED = [
  'READY',
  'NEW_ACCOUNT',
  'LEGACY_ACCOUNT_UNINITIALIZED',
  'RESTORABLE_IDENTITY',
  'UNRECOVERABLE_SERVER_IDENTITY',
  'INCONSISTENT',
];

describe('accountCryptoState hardening', () => {
  beforeEach(() => {
    tables.user_public_keys = { data: null, error: null };
    tables.user_backups = { data: [], error: null };
    tables.user_devices = { data: [], error: null };
  });

  it('classifies a brand new account', async () => {
    const result = await inspectAccountCryptoState(USER);
    expect(result.state).toBe('NEW_ACCOUNT');
    expect(ALLOWED).toContain(result.state);
  });

  it('classifies a legacy account that has devices but never published an identity', async () => {
    tables.user_devices = { data: [{ id: 'd1' }], error: null };
    const result = await inspectAccountCryptoState(USER);
    expect(result.state).toBe('LEGACY_ACCOUNT_UNINITIALIZED');
  });

  it('never resets an account whose identity is still restorable', async () => {
    tables.user_public_keys = { data: { fingerprint: 'fp' }, error: null };
    tables.user_backups = { data: [{ backup_type: 'account' }], error: null };
    const result = await inspectAccountCryptoState(USER);
    expect(result.state).toBe('RESTORABLE_IDENTITY');
    expect(result.hasRestorableBackup).toBe(true);
  });

  it('exposes UNRECOVERABLE only without any backup', async () => {
    tables.user_public_keys = { data: { fingerprint: 'fp' }, error: null };
    const result = await inspectAccountCryptoState(USER);
    expect(result.state).toBe('UNRECOVERABLE_SERVER_IDENTITY');
  });

  it('fails closed when a server probe is incomplete', async () => {
    tables.user_devices = { data: null, error: { message: 'offline' } };
    const result = await inspectAccountCryptoState(USER);
    expect(result.state).toBe('INCONSISTENT');
  });

  it('is idempotent: two consecutive inspections return the same state', async () => {
    const a = await inspectAccountCryptoState(USER);
    const b = await inspectAccountCryptoState(USER);
    expect(a.state).toBe(b.state);
  });
});
