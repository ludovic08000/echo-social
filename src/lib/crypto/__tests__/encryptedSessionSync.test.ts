import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- In-memory Supabase mock -------------------------------------------------
interface Row { user_id: string; device_id: string; conversation_id: string; kind: string; encrypted_blob: string; iv: string }
const store: Row[] = [];

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the supabase query builder */
vi.mock('@/integrations/supabase/client', () => {
  const from = () => {
    const filters: Partial<Row> = {};
    const api: any = {
      upsert: (row: Row) => {
        const idx = store.findIndex(r =>
          r.user_id === row.user_id && r.device_id === row.device_id &&
          r.conversation_id === row.conversation_id && r.kind === row.kind);
        if (idx >= 0) store[idx] = row; else store.push(row);
        return { error: null };
      },
      select: () => api,
      eq: (col: string, val: string) => { (filters as any)[col] = val; return api; },
      maybeSingle: () => {
        const found = store.find(r => Object.entries(filters).every(([k, v]) => (r as any)[k] === v));
        return { data: found ?? null, error: null };
      },
      delete: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }),
    };
    return api;
  };
  return { supabase: { from } };
});

// --- Master key + identity mocks --------------------------------------------
let masterKey: CryptoKey | null = null;
vi.mock('../accountKeyBackup', () => ({
  getSessionMasterKey: () => masterKey,
  getSessionUserId: () => 'user-1',
}));
vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'device-1',
  isDeviceIdTemporary: () => false,
}));

import {
  initRatchetAsInitiator,
  initRatchetAsResponder,
} from '../ratchet';
import { bufferToBase64 } from '../utils';

/* eslint-disable @typescript-eslint/no-explicit-any -- X25519/Ed25519 not in lib.dom types */
const KX = { name: 'X25519' } as any;
const SIG = { name: 'Ed25519' } as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function loadSessionSync(enabled: boolean) {
  vi.stubEnv('VITE_ALLOW_E2EE_SESSION_ESCROW', enabled ? 'true' : 'false');
  return import('../encryptedSessionSync');
}

async function makeState() {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(64)).buffer;
  const bobDhPair = await crypto.subtle.generateKey(KX, true, ['deriveBits']) as CryptoKeyPair;
  const aliceIK = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const bobIK = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as CryptoKeyPair;
  const aliceIKB64 = bufferToBase64(await crypto.subtle.exportKey('raw', aliceIK.publicKey));
  const bobIKB64 = bufferToBase64(await crypto.subtle.exportKey('raw', bobIK.publicKey));
  await initRatchetAsInitiator('conv-1', sharedSecret, bobDhPair.publicKey, {
    myIdentityKeyB64: aliceIKB64, peerIdentityKeyB64: bobIKB64,
  });
  return initRatchetAsResponder('conv-1', sharedSecret, bobDhPair, {
    myIdentityKeyB64: bobIKB64, peerIdentityKeyB64: aliceIKB64,
  });
}

describe('encryptedSessionSync', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    store.length = 0;
    masterKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  });

  it('is disabled by default to preserve forward secrecy', async () => {
    const { pushEncryptedSession, pullEncryptedSession } = await loadSessionSync(false);
    const state = await makeState();

    expect(await pushEncryptedSession('conv-default-off', state)).toBe(false);
    expect(await pullEncryptedSession('conv-default-off')).toBeNull();
    expect(store).toHaveLength(0);
  });

  it('round-trips a ratchet state when escrow is explicitly enabled', async () => {
    const { pushEncryptedSession, pullEncryptedSession } = await loadSessionSync(true);
    const state = await makeState();
    const pushed = await pushEncryptedSession('conv-sync', state);
    expect(pushed).toBe(true);

    const restored = await pullEncryptedSession('conv-sync');
    expect(restored).not.toBeNull();
    expect(restored!.conversationId).toBe(state.conversationId);
  });

  it('stores only opaque ciphertext when explicitly enabled', async () => {
    const { pushEncryptedSession } = await loadSessionSync(true);
    const state = await makeState();
    await pushEncryptedSession('conv-blind', state);

    const row = store.find(r => r.conversation_id === 'conv-blind');
    expect(row).toBeTruthy();
    expect(row!.encrypted_blob).not.toContain('conversationId');
    expect(row!.encrypted_blob).not.toContain('rootKey');
    expect(row!.encrypted_blob).not.toContain(state.conversationId);
    expect(row!.iv).toBeTruthy();
  });

  it('is a no-op when the vault is locked', async () => {
    const { pushEncryptedSession } = await loadSessionSync(true);
    masterKey = null;
    const state = await makeState();
    const pushed = await pushEncryptedSession('conv-locked', state);
    expect(pushed).toBe(false);
    expect(store.find(r => r.conversation_id === 'conv-locked')).toBeUndefined();
  });

  it('returns null when pulling with a locked vault even if a blob exists', async () => {
    const { pushEncryptedSession, pullEncryptedSession } = await loadSessionSync(true);
    const state = await makeState();
    await pushEncryptedSession('conv-lock-pull', state);
    masterKey = null;
    const restored = await pullEncryptedSession('conv-lock-pull');
    expect(restored).toBeNull();
  });

  it('returns null when there is no backup', async () => {
    const { pullEncryptedSession } = await loadSessionSync(true);
    const restored = await pullEncryptedSession('conv-absent');
    expect(restored).toBeNull();
  });
});
