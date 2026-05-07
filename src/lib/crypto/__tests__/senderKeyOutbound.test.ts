/**
 * Sender Keys outbound pipeline — unit tests.
 *
 * Validates the orchestration in `senderKeyOutbound.ts`:
 *   1. Returns null when `enable_sender_keys=false` (caller falls back to pairwise).
 *   2. On the first send with the flag on, fans out an SKDM to every peer
 *      device (one row per recipient) AND emits a `sk1.` wire.
 *   3. Subsequent sends with the same chain do NOT re-fan-out the SKDM.
 *   4. After `invalidateSenderKeysFlag`, the next send re-fans-out (rotation case).
 *   5. The flag-cache TTL prevents repeated DB hits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ───────────────────────────────────────────────────────

vi.mock('@/integrations/supabase/client', () => {
  return {
    supabase: {
      from: vi.fn(),
      rpc: vi.fn(),
    },
  };
});

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: vi.fn(() => 'alice-dev-1'),
  isDeviceIdTemporary: vi.fn(() => false),
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  encryptPlaintextForDeviceTarget: vi.fn(async (input: any) => ({
    encryptedBody: `wrapped:${input.recipientDeviceId}:${input.plaintext.slice(0, 16)}`,
    senderDeviceId: input.senderDeviceId ?? 'alice-dev-1',
  })),
}));

import { supabase } from '@/integrations/supabase/client';
import { encryptPlaintextForDeviceTarget } from '@/lib/messaging/multiDeviceFanout';
import {
  tryEncryptViaSenderKeys,
  invalidateSenderKeysFlag,
} from '../senderKeyOutbound';
import { isSenderKeyWire } from '../senderKeys';

// ─── Test harness ────────────────────────────────────────────────────────

interface FakeRow {
  enable_sender_keys?: boolean;
  user_id?: string;
}

// Tiny in-memory KV that mimics `sender_key_state` upserts so the second
// send in a test re-loads the SAME owner state (otherwise we'd regenerate
// a fresh chain on every call and re-fan-out forever).
const ownerStore = new Map<string, any>();
const ownerKey = (conv: string, uid: string, did: string) => `${conv}::${uid}::${did}`;

function makeFromHandler(opts: {
  enableSenderKeys: boolean;
  participants: string[];
  insertSink: any[];
}) {
  return (table: string) => {
    if (table === 'conversations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { enable_sender_keys: opts.enableSenderKeys } as FakeRow,
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'conversation_participants') {
      return {
        select: () => ({
          eq: async () => ({
            data: opts.participants.map((u) => ({ user_id: u })),
            error: null,
          }),
        }),
      };
    }
    if (table === 'sender_key_distribution') {
      return {
        insert: async (rows: any) => {
          opts.insertSink.push(...rows);
          return { error: null };
        },
      };
    }
    if (table === 'sender_key_state') {
      // Capture the (conv, uid, did, is_owner) tuple from chained .eq() calls.
      let conv = '', uid = '', did = '', isOwner = true;
      const builder: any = {
        eq(col: string, val: any) {
          if (col === 'conversation_id') conv = val;
          else if (col === 'sender_user_id') uid = val;
          else if (col === 'sender_device_id') did = val;
          else if (col === 'is_owner') isOwner = !!val;
          return builder;
        },
        maybeSingle: async () => {
          if (!isOwner) return { data: null, error: null };
          const row = ownerStore.get(ownerKey(conv, uid, did));
          return { data: row ?? null, error: null };
        },
      };
      return {
        select: () => builder,
        upsert: async (row: any) => {
          if (row.is_owner) {
            ownerStore.set(
              ownerKey(row.conversation_id, row.sender_user_id, row.sender_device_id),
              row,
            );
          }
          return { error: null };
        },
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  };
}

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHARLIE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeConvId(seed: string): string {
  // Stable but unique per test → bypasses the in-memory fanout dedupe map.
  const hex = Array.from(seed.padEnd(12, 'x'))
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

beforeEach(() => {
  ownerStore.clear();
  (supabase.from as any).mockReset();
  (supabase.rpc as any).mockReset();
  (encryptPlaintextForDeviceTarget as any).mockClear();
  // Default RPC: list_active_devices_for_user returns 1 device per user.
  // Alice's device id matches the mocked getCurrentDeviceId() so she's
  // filtered out of the peer list (the orchestrator skips self).
  (supabase.rpc as any).mockImplementation(async (_fn: string, args: any) => {
    const isAlice = args.p_user_id === ALICE;
    return {
      data: [
        {
          device_id: isAlice ? 'alice-dev-1' : `${args.p_user_id.slice(0, 4)}-dev-1`,
          device_public_key: 'AAA=',
        },
      ],
      error: null,
    };
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('senderKeyOutbound — opt-in gating', () => {
  it('returns null when enable_sender_keys is false', async () => {
    const conv = makeConvId('off');
    const inserts: any[] = [];
    (supabase.from as any).mockImplementation(
      makeFromHandler({ enableSenderKeys: false, participants: [ALICE, BOB], insertSink: inserts }),
    );
    const wire = await tryEncryptViaSenderKeys(conv, ALICE, 'hi');
    expect(wire).toBeNull();
    expect(inserts).toHaveLength(0);
    expect(encryptPlaintextForDeviceTarget).not.toHaveBeenCalled();
  });

  it('first send: emits sk1. wire AND fans out 1 SKDM per peer device', async () => {
    const conv = makeConvId('on1');
    const inserts: any[] = [];
    (supabase.from as any).mockImplementation(
      makeFromHandler({
        enableSenderKeys: true,
        participants: [ALICE, BOB, CHARLIE],
        insertSink: inserts,
      }),
    );
    const wire = await tryEncryptViaSenderKeys(conv, ALICE, 'group hello');
    expect(wire).not.toBeNull();
    expect(isSenderKeyWire(wire!)).toBe(true);
    // 2 peers (Bob + Charlie), Alice's own device is filtered out
    expect(inserts).toHaveLength(2);
    expect(new Set(inserts.map((r) => r.recipient_user_id))).toEqual(new Set([BOB, CHARLIE]));
    for (const row of inserts) {
      expect(row.conversation_id).toBe(conv);
      expect(row.sender_user_id).toBe(ALICE);
      expect(typeof row.encrypted_skdm).toBe('string');
      expect(row.encrypted_skdm.startsWith('wrapped:')).toBe(true);
    }
  });

  it('same chain → second send does NOT re-fan-out the SKDM', async () => {
    const conv = makeConvId('on2');
    const inserts: any[] = [];
    (supabase.from as any).mockImplementation(
      makeFromHandler({
        enableSenderKeys: true,
        participants: [ALICE, BOB],
        insertSink: inserts,
      }),
    );
    const w1 = await tryEncryptViaSenderKeys(conv, ALICE, 'one');
    const w2 = await tryEncryptViaSenderKeys(conv, ALICE, 'two');
    expect(isSenderKeyWire(w1!)).toBe(true);
    expect(isSenderKeyWire(w2!)).toBe(true);
    // Only the first send produced an insert
    expect(inserts).toHaveLength(1);
  });

  it('invalidateSenderKeysFlag forces a re-fan-out on the next send', async () => {
    const conv = makeConvId('inv');
    const inserts: any[] = [];
    (supabase.from as any).mockImplementation(
      makeFromHandler({
        enableSenderKeys: true,
        participants: [ALICE, BOB],
        insertSink: inserts,
      }),
    );
    await tryEncryptViaSenderKeys(conv, ALICE, 'first');
    expect(inserts).toHaveLength(1);

    invalidateSenderKeysFlag(conv);
    await tryEncryptViaSenderKeys(conv, ALICE, 'second');
    // Re-fans out once more
    expect(inserts).toHaveLength(2);
  });

  it('flag cache: a second call within TTL skips the conversations lookup', async () => {
    const conv = makeConvId('ttl');
    const inserts: any[] = [];
    let convQueries = 0;
    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'conversations') {
        convQueries++;
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { enable_sender_keys: true },
                error: null,
              }),
            }),
          }),
        };
      }
      return makeFromHandler({
        enableSenderKeys: true,
        participants: [ALICE, BOB],
        insertSink: inserts,
      })(table);
    });

    await tryEncryptViaSenderKeys(conv, ALICE, 'a');
    await tryEncryptViaSenderKeys(conv, ALICE, 'b');
    expect(convQueries).toBe(1);
  });
});
