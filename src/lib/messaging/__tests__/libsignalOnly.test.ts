import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
describe('single Libsignal message engine', () => {
  it.each(['src/lib/crypto/deviceRatchet.ts', 'src/lib/crypto/x3dhRatchetBootstrap.ts', 'src/lib/messaging/repeatablePreKeyEnvelope.ts'])('removes retired engine %s', path => {
    expect(existsSync(resolve(process.cwd(), path))).toBe(false);
  });
  it('does not export old session APIs', () => {
    expect(source('src/e2ee-session/index.ts')).not.toContain('listKnownSessionIds');
  });
  it('routes both directions through Libsignal', () => {
    const fanout = source('src/lib/messaging/multiDeviceFanout.ts');
    expect(fanout).toContain('encryptForLibsignalDevice');
    expect(fanout).toContain('decryptFromLibsignalDevice');
    expect(fanout).not.toMatch(/deviceRatchet|repeatablePreKeyEnvelope|x3dhRatchetBootstrap/);
  });
});
