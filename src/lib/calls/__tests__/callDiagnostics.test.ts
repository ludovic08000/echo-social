import { beforeEach, describe, expect, it } from 'vitest';
import {
  AegisCallError,
  callErrorFromServer,
  callErrorUserMessage,
  clearCallTrace,
  readCallTrace,
  traceCall,
} from '../callDiagnostics';

beforeEach(() => clearCallTrace());

describe('Aegis call diagnostics', () => {
  it('exports only bounded opaque metadata', () => {
    for (let index = 0; index < 180; index += 1) {
      traceCall({
        direction: 'outgoing',
        stage: 'token_request',
        outcome: 'error',
        callId: `SECRET_CALL_${index}`,
        conversationId: 'SECRET_CONVERSATION',
        deviceId: 'SECRET_DEVICE',
        errorCode: 'CALL_TOKEN_TIMEOUT',
      });
    }
    const trace = readCallTrace();
    expect(trace).toHaveLength(160);
    expect(trace.at(-1)).toMatchObject({
      callRef: 'call-180',
      conversationRef: 'conv-001',
      deviceRef: 'dev-001',
      errorCode: 'CALL_TOKEN_TIMEOUT',
    });
    expect(JSON.stringify(trace)).not.toContain('SECRET');
  });

  it('maps server failures to stable user-safe errors', () => {
    const diagnosticId = '123e4567-e89b-42d3-a456-426614174000';
    const error = callErrorFromServer('CALL_DEVICE_NOT_INVITED', 'CALL_INTERNAL_ERROR', diagnosticId);
    expect(error).toBeInstanceOf(AegisCallError);
    expect(error.code).toBe('CALL_DEVICE_NOT_INVITED');
    expect(callErrorUserMessage(error)).toContain(diagnosticId);
  });

  it('does not echo arbitrary exception messages to users', () => {
    expect(callErrorUserMessage(new Error('SECRET_TOKEN_AND_USER_ID'))).not.toContain('SECRET');
  });
});
