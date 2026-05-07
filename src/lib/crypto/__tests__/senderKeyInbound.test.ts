/**
 * Sender Keys inbound consumer — unit tests.
 *
 * Validates `catchUpSenderKeyDistribution`:
 *   1. Fetches undelivered SKDM rows for the current device.
 *   2. Decrypts each via the pairwise transport, calls installSKDM, marks
 *      delivered=true.
 *   3. When pairwise decrypt fails (peer not ready), the row is skipped
 *      (no installSKDM call, no delivered=true update).
 *   4. When the decrypted plaintext is NOT a valid SKDM, the row is NOT
 *      marked delivered (defensive — installSKDM returned null).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
  },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: vi.fn(() => 'recipient-dev-1'),
  isDeviceIdTemporary: vi.fn(() => false),
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  tryDecryptDeviceTargetedBody: vi.fn(),
}));

vi.mock('../senderKeySession', () => ({
  installSKDM: vi.fn(),
}));

import { supabase } from '@/integrations/supabase/client';
import { tryDecryptDeviceTargetedBody } from '@/lib/messaging/multiDeviceFanout';
import { installSKDM } from '../senderKeySession';
import { catchUpSenderKeyDistribution } from '../senderKeyInbound';

const ME = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';

interface Row {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  encrypted_skdm: string;
}

function mockSelectRows(rows: Row[], updateSink: string[]) {
  (supabase.from as any).mockImplementation((table: string) => {
    if (table === 'sender_key_distribution') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: rows, error: null }),
                }),
              }),
            }),
          }),
        }),
        update: (patch: any) => ({
          eq: async (_col: string, id: string) => {
            if (patch.delivered === true) updateSink.push(id);
            return { error: null };
          },
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

const mkRow = (id: string, suffix = ''): Row => ({
  id,
  conversation_id: `conv-${id}`,
  sender_user_id: `sender-${id}`,
  sender_device_id: `sender-dev-${id}`,
  recipient_user_id: ME,
  recipient_device_id: 'recipient-dev-1',
  encrypted_skdm: `cipher-${id}${suffix}`,
});

beforeEach(() => {
  (supabase.from as any).mockReset();
  (tryDecryptDeviceTargetedBody as any).mockReset();
  (installSKDM as any).mockReset();
});

describe('senderKeyInbound — catchUpSenderKeyDistribution', () => {
  it('decrypts each row, installs the chain, marks delivered=true', async () => {
    const rows = [mkRow('a'), mkRow('b')];
    const updates: string[] = [];
    mockSelectRows(rows, updates);

    (tryDecryptDeviceTargetedBody as any).mockImplementation(async (r: any) =>
      `SKDM-${r.encrypted_body}`,
    );
    (installSKDM as any).mockResolvedValue({ ok: true });

    const res = await catchUpSenderKeyDistribution(ME);
    expect(res.processed).toBe(2);
    expect(res.installed).toBe(2);
    expect(installSKDM).toHaveBeenCalledTimes(2);
    expect(updates.sort()).toEqual(['a', 'b']);
  });

  it('skips rows where pairwise decrypt fails (no install, no delivered=true)', async () => {
    const rows = [mkRow('c')];
    const updates: string[] = [];
    mockSelectRows(rows, updates);

    (tryDecryptDeviceTargetedBody as any).mockResolvedValue(null);

    const res = await catchUpSenderKeyDistribution(ME);
    expect(res.installed).toBe(0);
    expect(installSKDM).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('does NOT mark delivered when installSKDM returns null (malformed payload)', async () => {
    const rows = [mkRow('d')];
    const updates: string[] = [];
    mockSelectRows(rows, updates);

    (tryDecryptDeviceTargetedBody as any).mockResolvedValue('not-an-skdm');
    (installSKDM as any).mockResolvedValue(null);

    const res = await catchUpSenderKeyDistribution(ME);
    expect(res.installed).toBe(0);
    expect(installSKDM).toHaveBeenCalledOnce();
    expect(updates).toHaveLength(0);
  });

  it('returns zero when no rows are pending', async () => {
    mockSelectRows([], []);
    const res = await catchUpSenderKeyDistribution(ME);
    expect(res).toEqual({ processed: 0, installed: 0 });
    expect(installSKDM).not.toHaveBeenCalled();
  });
});
