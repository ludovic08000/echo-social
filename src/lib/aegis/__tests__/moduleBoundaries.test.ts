
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendAegisOutboundMessage as modularSend } from '@/lib/aegis';
import { sendAegisOutboundMessage as legacySend } from '@/lib/messaging/aegisOutboundEngine';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Aegis module boundaries', () => {
  it('keeps the historical outbound import as the same public function', () => {
    expect(legacySend).toBe(modularSend);
  });

  it('keeps the crypto facade free of network and UI dependencies', () => {
    const cryptoSource = source('src/lib/aegis/crypto/index.ts');
    expect(cryptoSource).not.toContain('@/integrations/supabase');
    expect(cryptoSource).not.toMatch(/from ['\"]react['\"]/);
    expect(cryptoSource).not.toMatch(/from ['\"][^'\"]*toast[^'\"]*['\"]/);
  });

  it('keeps the transaction behind injected modules', () => {
    const transactionSource = source('src/lib/aegis/core/AegisOutboundTransaction.ts');
    expect(transactionSource).toContain('deps.device.ensureReady');
    expect(transactionSource).toContain('deps.crypto.createMessage');
    expect(transactionSource).toContain('deps.routing.buildCopies');
    expect(transactionSource).toContain('deps.transport.sendWithRetry');
    expect(transactionSource).toContain('deps.queue.put');
    expect(transactionSource).not.toContain("@/integrations/supabase/client");
  });

  it('keeps queue recovery outside the outbound dependency graph', () => {
    const queueSource = source('src/lib/aegis/queue/index.ts');
    expect(queueSource).not.toContain('getOutboxPayload');
    expect(queueSource).not.toContain('listOutboxPayloads');
  });

  it('keeps call-key exchange outside the message queue', () => {
    const callsSource = source('src/lib/aegis/calls/index.ts');
    expect(callsSource).not.toMatch(/from ['\"][^'\"]*outbox[^'\"]*['\"]/);
    expect(callsSource).not.toContain('sendMessageWithAegisRetry');
  });
});
