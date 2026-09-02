import { describe, expect, it } from 'vitest';
import { getMatrixConfig } from './config';

describe('getMatrixConfig', () => {
  it('keeps Matrix disabled when no homeserver is configured', () => {
    expect(getMatrixConfig({ VITE_MATRIX_ENABLED: 'true' }).enabled).toBe(false);
  });

  it('requires an explicit opt-in and normalizes the homeserver URL', () => {
    expect(getMatrixConfig({
      VITE_MATRIX_ENABLED: 'true',
      VITE_MATRIX_HOMESERVER_URL: 'https://matrix.example.test///',
    })).toEqual({
      enabled: true,
      homeserverUrl: 'https://matrix.example.test',
      sessionFunctionName: 'matrix-session',
    });
  });

  it('does not activate merely because a homeserver URL exists', () => {
    expect(getMatrixConfig({
      VITE_MATRIX_HOMESERVER_URL: 'https://matrix.example.test',
    }).enabled).toBe(false);
  });
});

