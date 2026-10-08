import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { parseRss, fetchRss, MAX_RSS_BYTES, MEDIA_FRESHNESS_MS, type RssSource } from '../../supabase/functions/partner-rss-sync/rss';
import { rssDestination, assertRssCoverage, FRENCH_REGIONS, RSS_CATALOG } from '../../supabase/functions/partner-rss-sync/catalog';
import { rssHandler } from '../../supabase/functions/partner-rss-sync/handler';

const now = Date.parse('2026-10-06T10:00:00Z');
const source: RssSource = {
  id: 'source-1', partner_id: 'partner-1', source_key: 'le-parisien', lease_token: 'lease-1',
  website_host: 'www.leparisien.fr', allow_excerpt: true, allow_youtube_embed: false,
  rights_until: '2026-11-01T00:00:00Z', etag: null, last_modified: null,
  country: 'FR', region: null, city: null,
};
const entry = (fields = '') => `<item><title>Actualité &amp; région</title><link>https://www.leparisien.fr/test?utm_source=rss</link><pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate>${fields}</item>`;
const rss = (items = entry()) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const response = (xml = rss()) => new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', etag: '"test"' } });
const secret = 'test-only-'.repeat(5);
const request = (key: string | null = secret, method = 'POST') => new Request('https://cloud.invalid/rss', { method, headers: key ? { 'x-media-cron-secret': key } : {} });
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  // jsdom lacks this Deno/Node server API; network behavior itself is injected below.
  vi.stubGlobal('AbortSignal', { timeout: () => new AbortController().signal });
});
afterEach(() => vi.unstubAllGlobals());

describe('daily RSS normalization', () => {
  it('catalogues all 18 regions but does not invent URLs or agreements for pending titles', () => {
    expect(Object.keys(FRENCH_REGIONS)).toHaveLength(18);
    expect(new Set(Object.values(RSS_CATALOG).filter(e => e.verified && e.regionCode).map(e => e.regionCode)).size).toBe(18);
    for (const [key, entry] of Object.entries(RSS_CATALOG).filter(([, e]) => e.verified)) {
      expect(new URL(rssDestination(key, entry.websiteHost!)).protocol).toBe('https:');
      expect(() => assertRssCoverage(key, { country: 'FR', region: entry.regionCode ? FRENCH_REGIONS[entry.regionCode] : null, city: entry.city })).not.toThrow();
    }
  });
  it('catalogues diverse positive-editorial sources for every specialized feed lane', () => {
    const expected = {
      science: ['cnrs-journal', 'futura-sciences', 'pour-la-science'],
      music: ['france-musique', 'le-monde-musiques', 'tsugi'],
      education: ['the-conversation-education', 'le-monde-education', 'cafe-pedagogique'],
      wellbeing: ['the-conversation-sante', 'psychologies', 'sante-publique-france-sante-mentale'],
      sport: ['le-monde-sport', 'franceinfo-sports', 'rmc-sport'],
    } as const;
    for (const [category, keys] of Object.entries(expected)) {
      for (const key of keys) {
        expect(RSS_CATALOG[key]).toMatchObject({ verified: true, editorialCategory: category });
        expect(rssDestination(key, RSS_CATALOG[key].websiteHost!)).toMatch(/^https:\/\//);
      }
    }
  });
  it('refuses incorrect edition geography before fetching or publishing', async () => {
    const fetcher = vi.fn();
    await expect(fetchRss({ ...source, source_key: 'actu-grand-est', website_host: 'actu.fr', region: 'Bretagne' }, fetcher)).rejects.toThrow('SOURCE_COVERAGE_MISMATCH');
    await expect(fetchRss({ ...source, region: 'Grand Est' }, fetcher)).rejects.toThrow('SOURCE_COVERAGE_MISMATCH');
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => assertRssCoverage('actu-ile-de-france', { country: 'FR', region: 'Ile de France', city: null })).not.toThrow();
  });
  it('retains plain metadata and approved image references, never publisher full text or script', async () => {
    const [item] = await parseRss(rss(entry('<description><![CDATA[<p>Info <b>locale</b></p><script>alert(1)</script>]]></description><content:encoded>FULL ARTICLE</content:encoded><enclosure url="https://evil.invalid/image"/>')), source, now);
    expect(item.title).toBe('Actualité & région'); expect(item.excerpt).toBe('Info locale');
    expect(item.canonical_url).toBe('https://www.leparisien.fr/test');
    expect(item.external_id).toMatch(/^rss:[a-f0-9]{64}$/);
    expect(JSON.stringify(item)).not.toMatch(/FULL ARTICLE|alert|enclosure|evil/);
  });
  it('extracts safe RSS/Atom thumbnails and rejects active or credentialed URLs', async () => {
    const [rssItem] = await parseRss(rss(entry('<media:thumbnail url="https://cdn.publisher.test/photo.jpg"/>')), source, now);
    expect(rssItem.thumbnail_url).toBe('https://cdn.publisher.test/photo.jpg');
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Bonjour</title><link rel="alternate" href="https://www.leparisien.fr/atom-image"/><link rel="enclosure" type="image/webp" href="https://img.publisher.test/p.webp"/><published>2026-10-06T09:00:00Z</published></entry></feed>';
    expect((await parseRss(atom, source, now))[0].thumbnail_url).toBe('https://img.publisher.test/p.webp');
    const html = rss(entry('<description><![CDATA[<p>Résumé<img data-src="https://cdn.publisher.test/from-html.jpg"></p>]]></description>'));
    expect((await parseRss(html, source, now))[0].thumbnail_url).toBe('https://cdn.publisher.test/from-html.jpg');
    for (const image of ['javascript:alert(1)','http://img.test/a.jpg','https://user:pass@img.test/a.jpg','https://127.0.0.1/a.jpg','https://cdn.publisher.test:444/a.jpg']) {
      const [item] = await parseRss(rss(entry(`<media:thumbnail url="${image}"/>`)), source, now);
      expect(item.thumbnail_url).toBeNull();
    }
  });
  it('classifies publisher video pages and only retains YouTube IDs when embedding is granted', async () => {
    const video = rss(entry('<media:content medium="video" type="video/mp4" url="https://www.youtube.com/watch?v=abcdefghijk"/><enclosure type="image/jpeg" url="https://cdn.publisher.test/video.jpg"/>'));
    const denied = (await parseRss(video, source, now))[0];
    expect(denied).toMatchObject({ kind: 'video', youtube_id: null, thumbnail_url: 'https://cdn.publisher.test/video.jpg' });
    const allowed = (await parseRss(video, { ...source, allow_youtube_embed: true }, now))[0];
    expect(allowed.youtube_id).toBe('abcdefghijk');
    const publisherPage = rss(entry().replace('/test?utm_source=rss', '/article/videos/reportage'))
      .replace('Actualité &amp; région', 'VIDÉO. Le reportage du jour');
    expect((await parseRss(publisherPage, source, now))[0].kind).toBe('video');
  });
  it('honors excerpt rights and expiry', async () => {
    const [item] = await parseRss(rss(entry('<description>Excerpt</description>')), { ...source, allow_excerpt: false, rights_until: '2026-10-07T00:00:00Z' }, now);
    expect(item.excerpt).toBe(''); expect(item.expires_at).toBe('2026-10-07T00:00:00.000Z');
    await expect(parseRss(rss(), { ...source, rights_until: '2020-01-01' }, now)).rejects.toThrow('PARTNER_RIGHTS_REQUIRED');
  });
  it('deduplicates canonical URLs despite GUID/trackers and does not refresh expiry daily', async () => {
    const a = await parseRss(rss(entry('<guid>A</guid>') + entry('<guid>B</guid>')), source, now);
    const b = await parseRss(rss(entry('<guid>C</guid>')).replace('utm_source=rss', 'fbclid=123'), source, now + 86400000);
    expect(a).toHaveLength(1); expect(a).toEqual(b);
  });
  it('supports Atom alternate links, skipping full content', async () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Bonjour</title><link rel="self" href="https://evil.invalid/self"/><link rel="alternate" href="https://www.leparisien.fr/atom"/><published>2026-10-06T09:00:00Z</published><summary>Résumé</summary><content>FULL ARTICLE</content></entry></feed>';
    const [item] = await parseRss(xml, source, now);
    expect(item.canonical_url).toBe('https://www.leparisien.fr/atom'); expect(item.excerpt).toBe('Résumé');
  });
  it.each(['http://www.leparisien.fr/x', 'https://www.leparisien.fr.evil.test/x', 'https://www.leparisien.fr@evil.test/x', 'https://www.leparisien.fr:444/x', 'javascript:alert(1)', 'https://127.0.0.1/x'])('rejects untrusted canonical URL %s', async url => {
    expect(await parseRss(rss().replace('https://www.leparisien.fr/test?utm_source=rss', url), source, now)).toEqual([]);
  });
  it('skips undated, future and expired articles rather than resurfacing them as new', async () => {
    for (const date of ['unknown', 'Tue, 06 Oct 2026 11:00:00 GMT', 'Mon, 01 Jan 2024 09:00:00 GMT']) {
      expect(await parseRss(rss().replace('Tue, 06 Oct 2026 09:00:00 GMT', date), source, now)).toEqual([]);
    }
  });
  it('only imports the current daily-news window while retaining a longer discussion lifetime', async () => {
    const recentDate = new Date(now - MEDIA_FRESHNESS_MS + 60_000).toUTCString();
    const staleDate = new Date(now - MEDIA_FRESHNESS_MS).toUTCString();
    const [recent] = await parseRss(rss().replace('Tue, 06 Oct 2026 09:00:00 GMT', recentDate), source, now);
    expect(recent).toBeDefined();
    expect(Date.parse(recent.expires_at) - Date.parse(recent.published_at)).toBe(7 * 86_400_000);
    expect(await parseRss(rss().replace('Tue, 06 Oct 2026 09:00:00 GMT', staleDate), source, now)).toEqual([]);
  });
  it('bounds items and sorts recent first', async () => {
    const xml = rss(Array.from({ length: 60 }, (_, i) => entry().replace('/test?', `/test-${i}?`)).join(''));
    expect(await parseRss(xml, source, now)).toHaveLength(50);
    await expect(parseRss(rss(entry().repeat(501)), source, now)).rejects.toThrow('TOO_MANY_ITEMS');
  });
  it('supports the Parisien title/link-only feed with a validated URL date, never the import date', async () => {
    const xml = rss('<item><title>Info</title><link>https://www.leparisien.fr/actualites/info-05-10-2026-ABCDEF123.php</link></item>');
    const [item] = await parseRss(xml, source, now);
    expect(item.published_at).toBe('2026-10-05T00:00:00.000Z');
    expect(await parseRss(xml, source, now + 86400000)).toEqual([]);
    expect(await parseRss(xml.replace('05-10-2026', '31-02-2026'), source, now)).toEqual([]);
  });
  it('permits the two live-verified regional destinations only for their exact publisher host', () => {
    expect(rssDestination('actu-grand-est', 'actu.fr')).toBe('https://actu.fr/grand-est/rss.xml');
    expect(rssDestination('la-provence-marseille', 'www.laprovence.com')).toBe('https://www.laprovence.com/rss/marseille.xml');
    expect(() => rssDestination('lunion-lardennais', 'www.lunion.fr')).toThrow('SOURCE_NOT_VERIFIED');
  });
  it.each([
    '<!DOCTYPE rss [<!ENTITY e SYSTEM "file:///secret">]>' + rss(),
    '<html><body>Access denied</body></html>', '<rss><channel></rss>',
    rss('<x>'.repeat(40) + 'deep' + '</x>'.repeat(40)),
    'a'.repeat(MAX_RSS_BYTES + 1),
  ])('rejects unsafe, invalid or excessive XML', async xml => {
    await expect(parseRss(xml, source, now)).rejects.toThrow();
  });
});

describe('bounded network fetch', () => {
  it('uses a reviewed URL without credentials, redirects or arbitrary hosts', async () => {
    const fetcher = vi.fn(async () => response());
    expect((await fetchRss(source, fetcher, now)).items).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://feeds.leparisien.fr/leparisien/rss'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(new Headers(init.headers).has('Cookie')).toBe(false);
    for (const key of ['actu-grand-est', 'la-provence-marseille', 'lunion-lardennais', 'constructor', 'https://127.0.0.1']) {
      expect(() => rssDestination(key, source.website_host)).toThrow('SOURCE_NOT_VERIFIED');
    }
    expect(() => rssDestination('le-parisien', 'evil.test')).toThrow();
  });
  it('uses conditional GET and accepts 304 only after prior success', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 304 }));
    const result = await fetchRss({ ...source, etag: '"previous"' }, fetcher, now);
    expect(result.status).toBe('not_modified'); expect(result.etag).toBe('"previous"');
    await expect(fetchRss(source, fetcher, now)).rejects.toThrow('UNEXPECTED_NOT_MODIFIED');
  });
  it('rejects HTML, bad status, oversized declared bodies and decompressed streams', async () => {
    for (const res of [new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }), new Response('bad', { status: 403 }), new Response('bad', { headers: { 'Content-Type': 'application/xml', 'Content-Length': String(MAX_RSS_BYTES + 1) } }), response('x'.repeat(MAX_RSS_BYTES + 1))]) {
      await expect(fetchRss(source, vi.fn(async () => res), now)).rejects.toThrow();
    }
  });
  it('never performs a network request with expired rights', async () => {
    const fetcher = vi.fn();
    await expect(fetchRss({ ...source, rights_until: '2020-01-01' }, fetcher, now)).rejects.toThrow('PARTNER_RIGHTS_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('server-only daily worker', () => {
  const setup = (enabled = true) => {
    const claim = vi.fn(async () => [{ ...source, rights_until: new Date(Date.now() + 86400000).toISOString() }]);
    const finish = vi.fn(async () => true);
    const fetcher = vi.fn(async () => response(rss().replace('Tue, 06 Oct 2026 09:00:00 GMT', new Date(Date.now() - 1000).toUTCString())));
    return { claim, finish, fetcher, handler: rssHandler({ secret, enabled, claim, finish, fetch: fetcher }) };
  };
  it('rejects anonymous/user calls and checks the secret before reading DB', async () => {
    const { handler, claim } = setup();
    for (const key of [null, 'user-access-token', 'wrong']) expect((await handler(request(key))).status).toBe(401);
    expect((await handler(request(secret, 'GET'))).status).toBe(405); expect(claim).not.toHaveBeenCalled();
  });
  it('accepts a staged scheduler secret during a zero-downtime rotation', async () => {
    const { claim, finish, fetcher } = setup();
    const stagedSecret = 'staged-rss-secret-that-is-long-enough-0001';
    const handler = rssHandler({ secret, nextSecret: stagedSecret, enabled: true, claim, finish, fetch: fetcher });
    expect((await handler(request(stagedSecret))).status).toBe(200);
    expect((await handler(request('wrong'))).status).toBe(401);
  });
  it('fails closed without cron secret and obeys the kill switch', async () => {
    const { claim, finish, handler } = setup(false);
    expect(await (await handler(request())).json()).toEqual({ status: 'disabled' }); expect(claim).not.toHaveBeenCalled();
    expect((await rssHandler({ secret: undefined, enabled: true, claim, finish })(request())).status).toBe(401);
  });
  it('imports through the leased server RPC with no user-controlled approval', async () => {
    const { handler, finish } = setup();
    expect(await (await handler(request())).json()).toMatchObject({ success: 1, failure: 0 });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ lease_token: 'lease-1' }), expect.objectContaining({ status: 'success', items: expect.arrayContaining([expect.objectContaining({ kind: 'article' })]) }));
  });
  it('records isolated fetch failures with sanitized codes and permits other feeds to finish', async () => {
    const { claim, finish, fetcher, handler } = setup();
    claim.mockResolvedValue([{ ...source, source_key: 'actu-grand-est' }, { ...source, id: 'source-2' }]);
    fetcher.mockRejectedValueOnce(new Error('secret and full publisher response must not be logged'));
    const res = await handler(request()); expect(res.status).toBe(207);
    expect(await res.json()).toMatchObject({ failure: 2 });
    expect(JSON.stringify(finish.mock.calls)).not.toContain('secret and full publisher');
  });
  it('reports DB failures and stale workers without claiming successful publication', async () => {
    const { claim, finish, handler } = setup();
    finish.mockResolvedValueOnce(false);
    expect(await (await handler(request())).json()).toMatchObject({ stale: 1, success: 0 });
    finish.mockRejectedValueOnce(new Error('DB error'));
    expect((await handler(request())).status).toBe(207);
    claim.mockRejectedValueOnce(new Error('DB unavailable'));
    expect((await handler(request())).status).toBe(503);
  });
});
