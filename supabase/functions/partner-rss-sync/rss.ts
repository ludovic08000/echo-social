import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { assertRssCoverage, rssDestination } from './catalog.ts';

export const MAX_RSS_BYTES = 1_000_000;
const DAY = 86_400_000;
// The feed is refreshed roughly every 23 hours. A 36-hour display/import
// horizon tolerates a delayed publisher or worker run without resurfacing
// week-old articles. Rows are retained longer so existing discussions survive.
export const MEDIA_FRESHNESS_MS = 36 * 60 * 60 * 1000;
export interface RssSource {
  id: string; partner_id: string; source_key: string; lease_token: string;
  website_host: string; allow_excerpt: boolean; allow_youtube_embed: boolean; rights_until: string;
  etag: string | null; last_modified: string | null;
  country: string; region: string | null; city: string | null;
}
export interface RssItem {
  external_id: string; title: string; excerpt: string; canonical_url: string;
  kind: 'article' | 'video'; youtube_id: string | null; thumbnail_url: string | null;
  published_at: string; expires_at: string;
}
type XmlNode = Record<string, unknown>;
const node = (value: unknown): XmlNode => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : {};
const text = (value: unknown): string => typeof value === 'string' ? value : typeof node(value)['#text'] === 'string' ? node(value)['#text'] as string : '';
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

const hasUnsafeUrlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || value[index] === '\\') return true;
  }
  return false;
};

// Only plain text is retained. Never store publisher HTML, full articles or scripts.
function plain(value: unknown, length: number): string {
  return text(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}

function canonical(value: string, host: string): string | null {
  if (!value || value.length > 2048 || hasUnsafeUrlCharacters(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function safeThumbnail(value: unknown): string | null {
  const candidate = text(value).trim();
  if (!candidate || candidate.length > 2048 || hasUnsafeUrlCharacters(candidate)) return null;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const localName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
    const literalAddress = host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') || localName || literalAddress) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function mediaValues(entry: XmlNode, key: string): unknown[] {
  return [
    ...list(entry[key]),
    ...list(entry['media:group']).flatMap(group => list(node(group)[key])),
  ];
}

function htmlImage(value: unknown): string | null {
  const markup = text(value);
  const pattern = /<img\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi;
  for (let match = pattern.exec(markup); match; match = pattern.exec(markup)) {
    const safe = safeThumbnail(match[1].replace(/&amp;/gi, '&'));
    if (safe) return safe;
  }
  return null;
}

function thumbnail(entry: XmlNode): string | null {
  const media = mediaValues(entry, 'media:content').map(node);
  const enclosure = list(entry.enclosure).map(node);
  const atomLinks = list(entry.link).map(node);
  const candidates = [
    ...mediaValues(entry, 'media:thumbnail').map(value => node(value)['@_url']),
    ...media.filter(value => value['@_medium'] === 'image' || String(value['@_type'] ?? '').startsWith('image/')).map(value => value['@_url']),
    ...enclosure.filter(value => String(value['@_type'] ?? '').startsWith('image/')).map(value => value['@_url']),
    ...atomLinks.filter(value => value['@_rel'] === 'enclosure' && String(value['@_type'] ?? '').startsWith('image/')).map(value => value['@_href']),
  ];
  for (const value of candidates) { const safe = safeThumbnail(value); if (safe) return safe; }
  for (const value of [entry.description, entry.summary, entry['content:encoded'], entry.content]) {
    const safe = htmlImage(value);
    if (safe) return safe;
  }
  return null;
}

const normalizedWord = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function isVideo(entry: XmlNode, url: string, title: string): boolean {
  const media = mediaValues(entry, 'media:content').map(node);
  const enclosure = list(entry.enclosure).map(node);
  const atomLinks = list(entry.link).map(node);
  const typedVideo = [
    ...media.map(value => `${String(value['@_medium'] ?? '')} ${String(value['@_type'] ?? '')}`),
    ...enclosure.map(value => String(value['@_type'] ?? '')),
    ...atomLinks.filter(value => value['@_rel'] === 'enclosure').map(value => String(value['@_type'] ?? '')),
  ].some(value => /(?:^|\s)video(?:\/|\s|$)/i.test(value));
  const categoryVideo = [...list(entry.category), ...mediaValues(entry, 'media:category')]
    .map(value => normalizedWord(text(value) || String(node(value)['@_label'] ?? '')))
    .some(value => value === 'video' || value === 'videos');
  const pathname = new URL(url).pathname;
  return typedVideo || mediaValues(entry, 'media:player').length > 0 || !!text(entry['yt:videoId'])
    || /\/(?:video|videos)(?:\/|$)/i.test(pathname) || /^\s*vid[eé]o\b[\s:.-]*/i.test(title) || categoryVideo;
}

function youtubeIdFromUrl(value: unknown): string | null {
  const candidate = text(value) || String(node(value)['@_url'] ?? node(value)['@_href'] ?? '');
  if (!candidate || hasUnsafeUrlCharacters(candidate)) return null;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
      id = url.searchParams.get('v') ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] ?? '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

function youtubeId(entry: XmlNode, allowed: boolean): string | null {
  if (!allowed) return null;
  const declared = text(entry['yt:videoId']).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(declared)) return declared;
  const candidates = [
    ...mediaValues(entry, 'media:player'),
    ...mediaValues(entry, 'media:content'),
    ...list(entry.enclosure),
    ...list(entry.link),
  ];
  for (const candidate of candidates) {
    const id = youtubeIdFromUrl(candidate);
    if (id) return id;
  }
  return null;
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

export async function parseRss(xml: string, source: Pick<RssSource, 'website_host' | 'allow_excerpt' | 'allow_youtube_embed' | 'rights_until'>, now = Date.now()): Promise<RssItem[]> {
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
    const kind = url && title ? (isVideo(entry, url, title) ? 'video' : 'article') : 'article';
    // Les vidéos restent fraîches 7 jours (rythme de publication hebdomadaire
    // des chaînes), les articles gardent la fenêtre de 36 h.
    const freshness = kind === 'video' ? 7 * DAY : MEDIA_FRESHNESS_MS;
    if (!url || !title || !Number.isFinite(published) || published > now
      || published <= now - freshness || expires <= now || deduped.has(url)) continue;
    deduped.set(url, {
      title, canonical_url: url, kind, youtube_id: kind === 'video' ? youtubeId(entry, source.allow_youtube_embed) : null,
      thumbnail_url: thumbnail(entry),
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

const validatorHeader = (value: string | null): string | null => value && value.length <= 256
  && !value.includes('\r') && !value.includes('\n') && !value.includes('\0') ? value : null;
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
