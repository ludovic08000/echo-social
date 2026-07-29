
export {
  AegisOrchestrator,
  createAegisOrchestrator,
  defaultAegisOrchestrator,
  sendAegisOutboundMessage,
  type AegisOutboundTransaction,
} from './core/AegisOrchestrator';
export type {
  AegisOutboundInput,
  AegisOutboundResult,
  FanoutCopyRow,
  OutboxExtra,
  OutboxPayload,
} from './core/types';
export {
  AEGIS_OUTBOX_TRANSITIONS,
  assertAegisOutboxTransition,
  canTransitionAegisOutbox,
} from './core/stateMachine';
export {
  errorMessage,
  failureStatus,
  requestSenderTrustRepair,
} from './core/errors';
