import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
describe('single Libsignal message engine', () => {
  it('routes both directions through Libsignal', () => {
    const fanout = source('src/lib/messaging/multiDeviceFanout.ts');
    expect(fanout).toContain("from '@/lib/crypto/libsignalRuntime'");
    expect(fanout).toContain('encryptForLibsignalDevice');
    expect(fanout).toContain('decryptFromLibsignalDevice');
  });

  it('accepts only Libsignal device-copy wire types', () => {
    const wire = source('src/lib/crypto/libsignalWire.ts');
    expect(wire).toContain("export const LIBSIGNAL_WIRE_PREFIX = 'aegis.libsignal.'");
    expect(wire).toContain("messageType !== 2 && messageType !== 3");
    expect(wire).toContain('/^aegis\\.libsignal\\.[23]\\.');
  });
});
