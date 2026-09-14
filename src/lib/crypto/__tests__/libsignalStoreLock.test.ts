import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { withLibsignalStoreLock } from '../libsignalStoreLock';
import { __test__ } from '../crossTabLock';

afterEach(() => __test__.clearLeases());

it('serializes sends and receives sharing a store even across conversations', async () => {
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withLibsignalStoreLock('alice', 'phone', async () => {
    events.push('send:start');
    started();
    await gate;
    events.push('send:commit');
  });
  await ready;
  const second = withLibsignalStoreLock('alice', 'phone', async () => {
    events.push('receive:start');
  });
  await withLibsignalStoreLock('bob', 'phone', async () => {
    events.push('other-account');
  });
  expect(events).toEqual(['send:start', 'other-account']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['send:start', 'other-account', 'send:commit', 'receive:start']);
});

it('releases the store after a failed operation', async () => {
  await expect(withLibsignalStoreLock('alice', 'phone', async () => {
    throw new Error('vault unavailable');
  })).rejects.toThrow('vault unavailable');
  await expect(withLibsignalStoreLock('alice', 'phone', async () => 42)).resolves.toBe(42);
});

it('routes both backend store locks through the shared cross-tab lock', () => {
  for (const name of ['aegisWasmBridge', 'libsignalPlatformBridge']) {
    expect(readFileSync(`src/lib/crypto/${name}.ts`, 'utf8')).toContain("from './libsignalStoreLock'");
  }
  expect(readFileSync('src/lib/crypto/libsignalStoreLock.ts', 'utf8')).toContain('runCrossTabExclusive(');
});
