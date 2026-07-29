
import {
  defaultAegisDependencies,
  type AegisRuntimeDependencies,
} from './dependencies';
import { executeAegisOutboundTransaction } from './AegisOutboundTransaction';
import type { AegisOutboundInput, AegisOutboundResult } from './types';

export type AegisOutboundTransaction = (
  input: AegisOutboundInput,
  dependencies: AegisRuntimeDependencies,
) => Promise<AegisOutboundResult>;

export class AegisOrchestrator {
  constructor(
    private readonly dependencies: AegisRuntimeDependencies = defaultAegisDependencies,
    private readonly transaction: AegisOutboundTransaction = executeAegisOutboundTransaction,
  ) {}

  send(input: AegisOutboundInput): Promise<AegisOutboundResult> {
    return this.transaction(input, this.dependencies);
  }
}

export function createAegisOrchestrator(
  dependencies: AegisRuntimeDependencies = defaultAegisDependencies,
  transaction: AegisOutboundTransaction = executeAegisOutboundTransaction,
): AegisOrchestrator {
  return new AegisOrchestrator(dependencies, transaction);
}

export const defaultAegisOrchestrator = createAegisOrchestrator();

export function sendAegisOutboundMessage(
  input: AegisOutboundInput,
): Promise<AegisOutboundResult> {
  return defaultAegisOrchestrator.send(input);
}
