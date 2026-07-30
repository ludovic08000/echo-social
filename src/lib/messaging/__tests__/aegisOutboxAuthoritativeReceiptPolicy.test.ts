import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/hooks/useAegisMessageQueue.ts'),
  'utf8',
);

describe('Aegis outbox authoritative receipt policy', () => {
  it('does not delete an encrypted outbox job from parent-row existence alone', () => {
    expect(source).toContain(
      '.filter((payload) => !isMultiDeviceEnvelopeBody(payload.encryptedBody))',
    );
    expect(source).toContain('const deliveredPlaintext = new Set<string>()');
    expect(source).not.toContain('const delivered = new Set<string>()');
  });

  it('resubmits encrypted retries through the exact authoritative RPC path', () => {
    const retryStart = source.indexOf('const retryMessage = useCallback');
    const retrySource = source.slice(retryStart);
    expect(retrySource).toContain('!isMultiDeviceEnvelopeBody(payload.encryptedBody)');
    expect(retrySource).toContain(
      'await sendMessage(payload.plaintext, payload.imageUrl, payload.extra, payload)',
    );
  });
});
