import { createHash, webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDbipLookup, DBIP_LANGUAGES, dbipLanguage, geoIpKey, localizeDbip, type DbipPlace } from '../../supabase/functions/_shared/dbip-lite';
import { dbipFromCloud } from '../../supabase/functions/_shared/dbip-storage';
import { trustedLocationIp } from '../../supabase/functions/local-media-location/location';
const place: DbipPlace = { country: 'FR', countryNames: { en: 'France', fr: 'France', ja: 'フランス', fa: 'فرانسه' },
  regionCode: 'GES', regionNames: { fr: 'Grand Est', ja: 'グラン・テスト' }, cityNames: { fr: 'Reims', ja: 'ランス' } };
const now = Date.parse('2026-10-07T12:00:00Z');
beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
function fixture(options: { badPlace?: boolean; stale?: boolean; overlapping?: boolean } = {}) {
  const chunk = bytes({ ranges: [['08080800', '080808ff', 0], ['08080a00', '08080aff', 0]],
    places: [options.badPlace ? { ...place, cityNames: { en: '<script>' } } : place] });
  const ipv6 = bytes({ ranges: [['20014860000000000000000000000000', '20014860ffffffffffffffffffffffff', 0]], places: [place] });
  const index = bytes({ format: 'forsure-dbip-lite', edition: '2026-10', databaseEpoch: (now - (options.stale ? 101 * 86400000 : 0)) / 1000,
    ranges: { '4': options.overlapping ? [['08080800', '08080aff', sha(chunk)], ['08080a00', '08080aff', sha(chunk)]] : [['08080800', '08080aff', sha(chunk)]],
      '6': [['20014860000000000000000000000000', '20014860ffffffffffffffffffffffff', sha(ipv6)]] } });
  const objects = new Map([['manifest.json', index], [`${sha(chunk)}.json`, chunk], [`${sha(ipv6)}.json`, ipv6]]);
  const read = vi.fn(async (file: string) => objects.get(file)!);
  return { index, objects, read, lookup: createDbipLookup({ read, manifestSha256: sha(index), now: () => now }) };
}
describe('offline DB-IP City Lite', () => {
  it.each(DBIP_LANGUAGES)('supports %s and keeps canonical targeting independent of translated names', lang => {
    const names = Object.fromEntries(DBIP_LANGUAGES.map(l => [l, `City-${l}`]));
    const result = localizeDbip({ ...place, cityNames: names }, dbipLanguage(lang), '2026-10');
    expect(result.display.city).toBe(`City-${lang}`);
    expect(result.city).toBe('City-fr'); expect(result.region).toBe('Grand Est'); expect(result.country).toBe('FR');
    expect(result).not.toHaveProperty('latitude');
  });
  it.each([['fr-CA,en;q=0.5', 'fr'], ['zh-TW', 'zh-CN'], ['pt-PT', 'pt-BR'], ['en;q=0.3,ko-KR;q=0.9', 'ko'],
    ['ja;q=0,es;q=0.5', 'es'], ['unsupported,*', 'en'], ['fr;q=oops,en', 'en']])('negotiates %s', (header, lang) => {
    expect(dbipLanguage(header)).toBe(lang);
  });
  it('falls back for missing translations, not fictitious translations', () => {
    expect(localizeDbip(place, 'ko', '2026-10').display).toEqual({ country: 'France', region: 'Grand Est', city: 'Reims', language: 'ko' });
    expect(localizeDbip({ ...place, regionCode: null, regionNames: {} }, 'fr', '2026-10')).toMatchObject({ region: null, city: null });
  });
  it.each([['GP', 'Guadeloupe'], ['MQ', 'Martinique'], ['GF', 'Guyane'], ['RE', 'La Réunion'], ['YT', 'Mayotte']])('normalizes %s to French catalogue', (country, region) => {
    expect(localizeDbip({ ...place, country }, 'en', '2026-10')).toMatchObject({ country: 'FR', region });
  });
  it.each(['127.0.0.1', '192.168.1.1', '10.2.3.4', '::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '2001:db8::1', '2001:0db8::1', '3fff:0000::1', '2001:0000::1', 'not-ip'])('rejects non-public %s before reading any data', async ip => {
    const { lookup, read } = fixture(); expect(await lookup(ip)).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
  it('requires a configured gateway-overwritten header', () => {
    const h = new Headers({ 'x-forwarded-for': '1.1.1.1, 8.8.8.8' });
    expect(trustedLocationIp(h)).toBeNull(); expect(trustedLocationIp(h, 'x-forwarded-for')).toBe('8.8.8.8');
    expect(trustedLocationIp(new Headers({ 'x-forwarded-for': '8.8.8.8, 127.0.0.1' }), 'x-forwarded-for')).toBeNull();
  });
  it('finds inclusive endpoints, gaps, IPv4 and IPv6; does not use DNS', async () => {
    const { lookup } = fixture();
    expect((await lookup('8.8.8.0', 'ja'))?.display.city).toBe('ランス');
    expect((await lookup('8.8.8.255'))?.city).toBe('Reims');
    expect(await lookup('8.8.9.1')).toBeNull(); expect(await lookup('1.1.1.1')).toBeNull();
    expect((await lookup('2001:4860:4860::8888'))?.city).toBe('Reims');
    expect(geoIpKey('2001:4860:4860::8888')?.key).toBe('20014860486000000000000000008888');
  });
  it('coalesces concurrent reads, caches by shard (not visitor) and negotiates each language independently', async () => {
    const { lookup, read } = fixture();
    const results = await Promise.all([lookup('8.8.8.8', 'ja'), lookup('8.8.8.9', 'fr')]);
    expect(results.map(r => r?.display.city)).toEqual(['ランス', 'Reims']);
    await lookup('8.8.8.10'); expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(read.mock.calls)).not.toContain('8.8.8.');
  });
  it.each([{ badPlace: true }, { stale: true }, { overlapping: true }])('falls back on unsafe or stale data %j', async opts => {
    expect(await fixture(opts).lookup('8.8.8.8')).toBeNull();
  });
  it('rejects corrupt, excessive and unavailable data without a paid fallback', async () => {
    const f = fixture(); f.objects.set('manifest.json', bytes({ corrupted: true }));
    expect(await f.lookup('8.8.8.8')).toBeNull();
    await f.lookup('8.8.8.8'); expect(f.read).toHaveBeenCalledTimes(1);
    const oversized = createDbipLookup({ manifestSha256: sha(f.index), read: async () => new Uint8Array(8_388_609) });
    expect(await oversized('8.8.8.8')).toBeNull();
    const offline = createDbipLookup({ manifestSha256: sha(f.index), read: async () => { throw Error('offline'); } });
    expect(await offline('8.8.8.8')).toBeNull();
  });
  it('uses only private same-project storage, rejects redirects, and never transmits a visitor IP', async () => {
    const f = fixture(); const fetcher = vi.fn(async (input: string) => new Response(f.objects.get(input.split('/').at(-1)!) as BodyInit));
    const env: Record<string, string> = { DBIP_LITE_ENABLED: 'true', DBIP_LITE_RELEASE: '2026-10-aaaaaaaaaaaa',
      DBIP_LITE_MANIFEST_SHA256: sha(f.index), SUPABASE_URL: 'https://cloud.test', SUPABASE_SERVICE_ROLE_KEY: 'private-server-key' };
    const lookup = dbipFromCloud(k => env[k], fetcher as typeof fetch);
    // Runtime freshness uses wall clock; fixture timestamp intentionally is the current edition.
    await lookup('8.8.8.8');
    expect(fetcher).toHaveBeenCalled();
    for (const call of fetcher.mock.calls) {
      const [url, init] = call as unknown as [string, RequestInit];
      expect(url).toMatch(/^https:\/\/cloud.test\/storage\/v1\/object\/authenticated\/geoip-lite\/2026-10-aaaaaaaaaaaa\//);
      expect(url).not.toContain('8.8.8.8'); expect(init.redirect).toBe('error');
    }
    fetcher.mockClear(); env.DBIP_LITE_ENABLED = 'false';
    expect(await dbipFromCloud(k => env[k], fetcher as typeof fetch)('8.8.8.8')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('aborts a slow storage read and stops retry storms for 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      let tick = now;
      const read = vi.fn((_file, _limit, signal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      }));
      const lookup = createDbipLookup({ read, manifestSha256: 'a'.repeat(64), now: () => tick });
      const waiting = lookup('8.8.8.8');
      await vi.advanceTimersByTimeAsync(2001);
      expect(await waiting).toBeNull(); expect(await lookup('8.8.8.8')).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
      tick += 30_001;
      const retry = lookup('8.8.8.8'); await vi.advanceTimersByTimeAsync(2001);
      expect(await retry).toBeNull(); expect(read).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('detects a corrupt shard even when the manifest itself is authentic', async () => {
    const f = fixture();
    for (const key of f.objects.keys()) if (key !== 'manifest.json') f.objects.set(key, bytes({ wrong: true }));
    expect(await f.lookup('8.8.8.8')).toBeNull(); expect(f.read).toHaveBeenCalledTimes(2);
  });
});
