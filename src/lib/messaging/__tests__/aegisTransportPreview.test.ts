import { describe, expect, it } from 'vitest';
import { resolveAegisGatewayUrl } from '@/lib/messaging/aegisTransport';

describe('Aegis gateway URL resolution', () => {
  it('keeps the configured production gateway on the production site', () => {
    expect(resolveAegisGatewayUrl(
      'https://aegis.forsure.fans/',
      { hostname: 'forsure.fans', origin: 'https://forsure.fans' },
    )).toBe('https://aegis.forsure.fans');
  });

  it('uses the exact same-origin gateway on Vercel Preview deployments', () => {
    expect(resolveAegisGatewayUrl(
      'https://aegis.forsure.fans',
      {
        hostname: 'echo-social-preview.vercel.app',
        origin: 'https://echo-social-preview.vercel.app',
      },
    )).toBe('https://echo-social-preview.vercel.app');
  });

  it('does not permit an insecure remote gateway URL', () => {
    expect(() => resolveAegisGatewayUrl(
      'http://remote.example',
      { hostname: 'forsure.fans', origin: 'https://forsure.fans' },
    )).toThrow('AEGIS_SERVER_HTTPS_REQUIRED');
  });
});
