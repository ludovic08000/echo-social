import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { assertRssCoverage, rssDestination } from './catalog.ts';

export const MAX_RSS_BYTES = 1_000_000;
const DAY = 86_400_000;
export interface RssSource {
  id: string; partner_id: string; source_key: string; lease_token: string;
  website_host: string; allow_excerpt: boolean; rights_until: string;
  etag: string | null; last_modified: string | null;
  country: string; region: string | null; city: string | null;
}
export interface RssItem {
  external_id: string; title: string; excerpt: string; canonical_url: string;
  kind: 'article'; published_at: string; expires_at: string;
}
type XmlNode = Record<string, unknown>;
const node = (value: unknown): XmlNode => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : {};
const text = (value: unknown): string => typeof value === 'string' ? value : typeof node(value)['#text'] === 'string' ? node(value)['#text'] as string : '';
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

// Only plain text is retained. Never store publisher HTML, full articles, images or scripts.
function plain(value: unknown, length: number): string {
  return text(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}

function canonical(value: string, host: string): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function parisienUrlDate(url: string): number {
  // Ce flux omet pubDate : sa date éditoriale est présente dans l'URL, jamais remplacée par la date d'import.
  const parsed = new URL(url);
  if (parsed.hostname !== 'www.leparisien.fr') return NaN;
  const match = parsed.pathname.match(/-(\d{2})-(\d{2})-(\d{4})-[A-Z0-9]+\.php$/);
  if (!match) return NaN;
  const iso = `${match[3]}-${match[2]}-${match[1]}T00:00:00.000Z`;
  const stamp = Date.parse(iso);
  return Number.isFinite(stamp) && new Date(stamp).toISOString() === iso ? stamp : NaN;
}

export async function parseRss(xml: string, source: Pick<RssSource, 'website_host' | 'allow_excerpt' | 'rights_until'>, now = Date.now()): Promise<RssItem[]> {
  if (new TextEncoder().encode(xml).length > MAX_RSS_BYTES) throw new Error('FEED_TOO_LARGE');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('UNSAFE_XML');
  const until = Date.parse(source.rights_until);
  if (!Number.isFinite(until) || until <= now) throw new Error('PARTNER_RIGHTS_REQUIRED');
  if (XMLValidator.validate(xml) !== true) throw new Error('INVALID_XML');
  let root: XmlNode;
  try {
    root = node(new XMLParser({
      ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
      removeNSPrefix: false, maxNestedTags: 32, ignorePiTags: true,
      processEntities: { enabled: true, maxExpansionDepth: 2, maxTotalExpansions: 10000, maxExpandedLength: MAX_RSS_BYTES },
    }).parse(xml));
  } catch { throw new Error('INVALID_XML'); }
  const rss = node(root.rss), atom = node(root.feed);
  if (!rss.channel && !root.feed) throw new Error('UNSUPPORTED_FEED');
  const entries = list(root.feed ? atom.entry : node(rss.channel).item);
  if (entries.length > 500) throw new Error('TOO_MANY_ITEMS');
  const deduped = new Map<string, Omit<RssItem, 'external_id'>>();
  for (const raw of entries) {
    const entry = node(raw);
    const href = root.feed ? text(node(list(entry.link).find(link => !node(link)['@_rel'] || node(link)['@_rel'] === 'alternate'))['@_href']) : text(entry.link);
    const url = canonical(href, source.website_host);
    const title = plain(entry.title, 220);
    // Never substitute "now" for a missing date: that would republish old news daily.
    const declaredDate = text(entry.pubDate ?? entry.published ?? entry['dc:date'] ?? entry.updated);
    const published = declaredDate ? Date.parse(declaredDate) : url ? parisienUrlDate(url) : NaN;
    const expires = Math.min(published + 7 * DAY, until);
    if (!url || !title || !Number.isFinite(published) || published > now || expires <= now || deduped.has(url)) continue;
    deduped.set(url, {
      title, canonical_url: url, kind: 'article',
      excerpt: source.allow_excerpt ? plain(entry.description ?? entry.summary, 400) : '',
      published_at: new Date(published).toISOString(), expires_at: new Date(expires).toISOString(),
    });
  }
  const items = [...deduped.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 50);
  return Promise.all(items.map(async item => {
    // Stable across retries, GUID changes and tracking parameters; never expose the URL as a DB key.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.canonical_url));
    return { ...item, external_id: 'rss:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
  }));
}

const validatorHeader = (value: string | null): string | null => value && value.length <= 256 && !/[\r\n\u0000]/.test(value) ? value : null;
export interface FetchResult { status: 'success' | 'not_modified'; items: RssItem[]; etag: string | null; last_modified: string | null }
export async function fetchRss(source: RssSource, fetcher: typeof fetch = fetch, now = Date.now()): Promise<FetchResult> {
  const url = rssDestination(source.source_key, source.website_host);
  assertRssCoverage(source.source_key, source);
  if (Date.parse(source.rights_until) <= now || !Number.isFinite(Date.parse(source.rights_until))) throw new Error('PARTNER_RIGHTS_REQUIRED');
  const headers = new Headers({ Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'User-Agent': 'ForSureRSS/1.0 (+https://forsure.fans)' });
  const etag = validatorHeader(source.etag), modified = validatorHeader(source.last_modified);
  if (etag) headers.set('If-None-Match', etag);
  if (modified) headers.set('If-Modified-Since', modified);
  let response: Response;
  try { response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error('FETCH_FAILED'); }
  const metadata = { etag: validatorHeader(response.headers.get('etag')), last_modified: validatorHeader(response.headers.get('last-modified')) };
  if (response.status === 304) {
    if (!etag && !modified) throw new Error('UNEXPECTED_NOT_MODIFIED');
    return { status: 'not_modified', items: [], etag: metadata.etag ?? etag, last_modified: metadata.last_modified ?? modified };
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (response.status !== 200 || !['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'].includes(type ?? '')) {
    await response.body?.cancel(); throw new Error('FEED_RESPONSE_REJECTED');
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RSS_BYTES) { await response.body?.cancel(); throw new Error('FEED_TOO_LARGE'); }
  if (!response.body) throw new Error('EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_RSS_BYTES) throw new Error('FEED_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('INVALID_ENCODING'); }
  return { status: 'success', items: await parseRss(xml, source, now), ...metadata };
}
