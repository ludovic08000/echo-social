
import { describe, expect, it } from 'vitest';
import {
  assertAegisOutboxTransition,
  canTransitionAegisOutbox,
} from '../core/stateMachine';

 describe('Aegis outbox state machine', () => {
  it('allows the normal encrypted send lifecycle', () => {
    expect(canTransitionAegisOutbox('pending_local', 'encrypting')).toBe(true);
    expect(canTransitionAegisOutbox('encrypting', 'sending')).toBe(true);
    expect(canTransitionAegisOutbox('sending', 'sent')).toBe(true);
  });

  it('rejects a committed message returning to encryption', () => {
    expect(() => assertAegisOutboxTransition('sent', 'encrypting'))
      .toThrow('AEGIS_INVALID_OUTBOX_TRANSITION');
  });
});
