import { describe, expect, it, vi } from 'vitest';
import {
  normalizePublicIp,
  readTrustedClientIp,
  resolveLoginNetworkContext,
} from '../../../../supabase/functions/login-security/networkContext';

describe('login network context', () => {
  it('accepts public proxy addresses and rejects local/private addresses', () => {
    expect(normalizePublicIp('8.8.8.8')).toBe('8.8.8.8');
    expect(normalizePublicIp('192.168.1.20')).toBeNull();
    expect(normalizePublicIp('127.0.0.1')).toBeNull();
    expect(normalizePublicIp('2001:4860:4860::8888')).toBe('2001:4860:4860::8888');
    expect(normalizePublicIp('::1')).toBeNull();
  });

  it('prefers gateway headers and uses the right-most forwarded public address', () => {
    expect(readTrustedClientIp(new Headers({
      'cf-connecting-ip': '8.8.8.8',
      'x-forwarded-for': '9.9.9.9, 1.1.1.1',
    }))).toBe('8.8.8.8');

    expect(readTrustedClientIp(new Headers({
      'x-forwarded-for': '10.0.0.2, 9.9.9.9',
    }))).toBe('9.9.9.9');
  });

  it('resolves city and region server-side without trusting client country headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      city: 'Paris',
      region: 'Île-de-France',
      country: 'fr',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const request = new Request('https://example.test', {
      headers: {
        'x-real-ip': '8.8.8.8',
        'x-country-code': 'US',
      },
    });

    await expect(resolveLoginNetworkContext(request, {
      ipinfoToken: 'test-token',
      fetchImpl,
    })).resolves.toEqual({
      ip: '8.8.8.8',
      country: 'FR',
      region: 'Île-de-France',
      city: 'Paris',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the trusted country and fails soft when enrichment is unavailable', async () => {
    const request = new Request('https://example.test', {
      headers: {
        'cf-connecting-ip': '8.8.8.8',
        'cf-ipcountry': 'FR',
      },
    });
    await expect(resolveLoginNetworkContext(request)).resolves.toEqual({
      ip: '8.8.8.8',
      country: 'FR',
      region: null,
      city: null,
    });
  });
});
