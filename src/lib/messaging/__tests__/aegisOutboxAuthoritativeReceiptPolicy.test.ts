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

  it('re-reads and mutates one durable row only inside the cross-tab single-flight lock', () => {
    const retryStart = source.indexOf('const retryMessage = useCallback');
    const removeStart = source.indexOf('const removeMessage = useCallback');
    const retrySource = source.slice(retryStart, removeStart);
    expect(retrySource.indexOf('runAegisOutboxJob')).toBeGreaterThanOrEqual(0);
    expect(retrySource.indexOf('getOutboxPayload')).toBeGreaterThan(
      retrySource.indexOf('runAegisOutboxJob'),
    );

    const terminalSource = source.slice(removeStart);
    expect(terminalSource).toContain('runAegisOutboxJob(`${user.id}:${localId}`');
    expect(terminalSource).toContain('await deleteOutboxPayload(localId)');
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
