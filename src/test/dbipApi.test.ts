import { describe, expect, it, vi } from 'vitest';
import { locateWithDbipFree } from '../../supabase/functions/_shared/dbip-api';

describe('DB-IP HTTPS coarse location fallback', () => {
  it('returns only a canonical French coarse zone', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ipAddress: '8.8.8.8', countryCode: 'FR', stateProv: 'grand-est', city: 'Charleville-Mézières',
      latitude: 49.77, longitude: 4.72,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(locateWithDbipFree('8.8.8.8', fetcher as typeof fetch)).resolves.toEqual({
      country: 'FR', region: 'Grand Est', city: 'Charleville-Mézières',
    });
    expect(fetcher).toHaveBeenCalledWith('https://api.db-ip.com/v2/free/8.8.8.8', expect.objectContaining({
      redirect: 'error', headers: { Accept: 'application/json', 'Accept-Language': 'fr' },
    }));
  });

  it.each([
    [{ countryCode: 'BE', stateProv: 'Wallonie', city: 'Namur' }],
    [{ countryCode: 'FR', stateProv: 'Unknown', city: 'Paris' }],
    [{ errorCode: 'OVER_QUERY_LIMIT', error: 'quota' }],
  ])('fails closed for an unusable response %#', async (payload) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(locateWithDbipFree('8.8.8.8', fetcher as typeof fetch)).resolves.toBeNull();
  });

  it('maps French overseas territories to the French media catalogue', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      countryCode: 'RE', stateProv: 'La Réunion', city: 'Saint-Denis',
    }), { status: 200 }));
    await expect(locateWithDbipFree('8.8.8.8', fetcher as typeof fetch)).resolves.toEqual({
      country: 'FR', region: 'La Réunion', city: 'Saint-Denis',
    });
  });

  it('does not call DB-IP for a private or malformed address', async () => {
    const fetcher = vi.fn();
    await expect(locateWithDbipFree('192.168.1.10', fetcher as typeof fetch)).resolves.toBeNull();
    await expect(locateWithDbipFree('not-an-ip', fetcher as typeof fetch)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects failed and oversized responses', async () => {
    await expect(locateWithDbipFree('8.8.8.8', vi.fn(async () => new Response('{}', { status: 503 })) as typeof fetch)).resolves.toBeNull();
    const oversized = 'x'.repeat(16_385);
    await expect(locateWithDbipFree('8.8.8.8', vi.fn(async () => new Response(oversized)) as typeof fetch)).resolves.toBeNull();
  });
});
