import { describe, it, expect } from 'vitest';
import { isSecurePipelineEnvelope, unwrapSecurePipelineEnvelope } from '../secureMessagePipeline';

describe('secure pipeline envelope', () => {
  it('rejects invalid payloads', () => {
    expect(isSecurePipelineEnvelope('hello')).toBe(false);
  });

  it('unwraps valid secure envelopes', () => {
    const payload = JSON.stringify({
      fs_secure_pipeline: 1,
      body: 'ciphertext',
      meta: {
        identityEpoch: 1,
        payload: {},
      },
    });

    expect(isSecurePipelineEnvelope(payload)).toBe(true);
    expect(unwrapSecurePipelineEnvelope(payload)?.body).toBe('ciphertext');
  });
});
