import { describe, it, expect, beforeEach } from 'vitest';
import {
  transition,
  getSnapshot,
  withEnsureLock,
  __resetForTests,
} from '../CryptoStateMachine';

const USER = '00000000-0000-0000-0000-000000000001';

describe('CryptoStateMachine', () => {
  beforeEach(() => __resetForTests());

  it('starts uninitialized and walks the happy path', () => {
    expect(getSnapshot(USER).state).toBe('uninitialized');
    transition(USER, 'storage_checking', 'boot');
    transition(USER, 'identity_loaded', 'idb-hit');
    transition(USER, 'ready', 'done');
    expect(getSnapshot(USER).state).toBe('ready');
  });

  it('walks the restore path', () => {
    transition(USER, 'storage_checking', 'boot');
    transition(USER, 'backup_restore_required', 'idb-empty-server-backup');
    transition(USER, 'backup_restoring', 'user-entered-pin');
    transition(USER, 'identity_loaded', 'restore-ok');
    transition(USER, 'ready', 'done');
  });

  it('refuses illegal transitions', () => {
    transition(USER, 'storage_checking', 'boot');
    expect(() => transition(USER, 'ready', 'jump')).toThrow(/illegal transition/);
  });

  it('treats duplicate boot transitions as idempotent', () => {
    transition(USER, 'storage_checking', 'boot');
    expect(() => transition(USER, 'storage_checking', 'duplicate-boot')).not.toThrow();
    expect(getSnapshot(USER).state).toBe('storage_checking');
    expect(getSnapshot(USER).reason).toBe('duplicate-boot');
  });

  it('NEVER allows identity_creating twice in the same session', () => {
    transition(USER, 'storage_checking', 'boot');
    transition(USER, 'identity_creating', 'no-backup-1');
    transition(USER, 'identity_loaded', 'created');
    transition(USER, 'ready', 'done');

    transition(USER, 'storage_checking', 'idb-purged-by-itp');
    expect(() => transition(USER, 'identity_creating', 'no-backup-2')).toThrow(
      /already created this session/,
    );
  });

  it('serialises concurrent ensure locks', async () => {
    let count = 0;
    const fn = async () => {
      count += 1;
      await new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all([
      withEnsureLock(USER, fn),
      withEnsureLock(USER, fn),
      withEnsureLock(USER, fn),
    ]);
    // The same in-flight promise is shared → fn must run only once.
    expect(count).toBe(1);
  });
});
