import { beforeEach, describe, expect, it, vi } from 'vitest';

const sealed = new Map<string, unknown>();

vi.mock('../deviceVault', () => ({
  deviceVaultMirrorsPlaintext: () => false,
  writeDeviceVaultRecord: vi.fn(async (id: string, value: unknown) => { sealed.set(id, structuredClone(value)); }),
  readDeviceVaultRecord: vi.fn(async (id: string, validate: (value: unknown) => boolean) => {
    const value = sealed.get(id);
    return value !== undefined && validate(value) ? structuredClone(value) : null;
  }),
  removeDeviceVaultRecord: vi.fn(async (id: string) => { sealed.delete(id); }),
  listDeviceVaultStorageIds: vi.fn(async (prefix: string) =>
    [...sealed.keys()].filter((id) => id.startsWith(prefix))),
  adoptLegacyPlaintextRecord: vi.fn(),
}));

import {
  captureDeviceSessionSnapshot,
  readDeviceSessionRecord,
  restoreDeviceSessionSnapshot,
  writeDeviceSessionRecord,
} from '../deviceSessionStore';

describe('Signal-style iOS durable session store', () => {
  beforeEach(() => sealed.clear());

  it('restores active ratchet and unacknowledged initial state from sealed storage', async () => {
    const userId = 'user-ios';
    const deviceId = 'dev_ios';
    const id = `${userId}::${deviceId}::peer::dev_windows`;
    const session = { id, sessionId: 'session-1', rootKeyB64: 'sealed-root' };
    const initiating = { id, sessionId: 'session-1', expiresAt: Date.now() + 60_000 };

    await writeDeviceSessionRecord('sessions', session);
    await writeDeviceSessionRecord('initiating-sessions', initiating);
    const snapshot = await captureDeviceSessionSnapshot(userId, deviceId);

    sealed.clear();
    await restoreDeviceSessionSnapshot(userId, deviceId, snapshot);

    await expect(readDeviceSessionRecord('sessions', id)).resolves.toEqual(session);
    await expect(readDeviceSessionRecord('initiating-sessions', id)).resolves.toEqual(initiating);
  });

  it('rejects a session snapshot scoped to another physical device', async () => {
    await expect(restoreDeviceSessionSnapshot('user-ios', 'dev_ios', {
      sessions: [{ id: 'user-ios::dev_other::peer::dev_windows' }],
      initiating: [],
    })).rejects.toThrow('DEVICE_SESSION_SNAPSHOT_SCOPE_INVALID');
  });
});
