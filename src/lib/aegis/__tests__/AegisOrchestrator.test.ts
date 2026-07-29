
import { describe, expect, it, vi } from 'vitest';
import {
  AegisOrchestrator,
  type AegisOutboundTransaction,
} from '../core/AegisOrchestrator';
import type { AegisRuntimeDependencies } from '../core/dependencies';
import type { AegisOutboundInput, AegisOutboundResult } from '../core/types';

const input: AegisOutboundInput = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  senderUserId: '22222222-2222-4222-8222-222222222222',
  plaintext: 'hello',
};

const result: AegisOutboundResult = {
  id: '33333333-3333-4333-8333-333333333333',
  parentBody: 'encrypted-parent',
  transportPlaintext: 'hello',
  copies: [],
  retriedStaleRoute: false,
  localId: 'local-1',
  traceId: 'trace-1',
};

describe('AegisOrchestrator', () => {
  it('delegates one send to the injected transaction with the injected modules', async () => {
    const dependencies = { marker: 'deps' } as unknown as AegisRuntimeDependencies;
    const transaction = vi.fn<AegisOutboundTransaction>().mockResolvedValue(result);
    const orchestrator = new AegisOrchestrator(dependencies, transaction);

    await expect(orchestrator.send(input)).resolves.toEqual(result);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(input, dependencies);
  });
});
