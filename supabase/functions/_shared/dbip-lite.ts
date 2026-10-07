import { frenchRegion } from '../local-media-location/context.ts';
import { normalizePublicIp } from '../login-security/networkContext.ts';

// Names only: no coordinates, IP history, identity decisions or external IP API.
export const DBIP_LANGUAGES = ['en', 'fr', 'de', 'es', 'pt-BR', 'zh-CN', 'ja', 'ru', 'fa', 'ko'] as const;
type Language = typeof DBIP_LANGUAGES[number];
type Names = Partial<Record<Language, string>>;
export type DbipPlace = { country: string; countryNames: Names; regionCode: string | null; regionNames: Names; cityNames: Names };
export type DbipLocation = {
  country: string; region: string | null; city: string | null;
  provider: 'db-ip-lite'; approximate: true; edition: string;
  display: { country: string; region: string | null; city: string | null; language: Language };
};
type Range<T> = [string, string, T];
type Manifest = { format: 'forsure-dbip-lite'; edition: string; databaseEpoch: number; ranges: { '4': Range<string>[]; '6': Range<string>[] } };
type Shard = { ranges: Range<number>[]; places: DbipPlace[] };
export type ReadGeoObject = (name: string, limit: number, signal: AbortSignal) => Promise<Uint8Array>;
const SHA = /^[a-f0-9]{64}$/;
const MAX_SHARD = 262_144;
const MAX_MANIFEST = 8_388_608;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validLabel = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\u0000-\u001f\u007f<>]/.test(v);

export function dbipLanguage(header = ''): Language {
  // Bounded Accept-Language parsing, including regional aliases and q=0 exclusion.
  const choices = header.slice(0, 512).split(',').map((part, order) => {
    const [tag, ...params] = part.trim().split(';');
    const quality = params.find(p => p.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { tag: tag.toLowerCase(), q, order };
  }).filter(p => Number.isFinite(p.q) && p.q > 0 && p.q <= 1).sort((a, b) => b.q - a.q || a.order - b.order);
  for (const { tag } of choices) {
    const base = tag.split('-')[0];
    const lang = DBIP_LANGUAGES.find(l => l.toLowerCase().split('-')[0] === base);
    if (lang) return lang;
  }
  return 'en';
}
const name = (names: Names, language: Language) => names[language] ?? names.en ?? names.fr
  ?? DBIP_LANGUAGES.map(l => names[l]).find(Boolean) ?? null;

export function localizeDbip(place: DbipPlace, language: Language, edition: string): DbipLocation {
  const france = ['FR', 'GP', 'MQ', 'GF', 'RE', 'YT'].includes(place.country);
  // Stable catalogue/advertising keys must never depend on the viewer's language.
  const region = france ? frenchRegion(place.country, place.regionCode)
    ?? frenchRegion(place.country, place.regionNames.fr) ?? frenchRegion(place.country, place.regionNames.en)
    : name(place.regionNames, 'en');
  const city = region ? name(place.cityNames, france ? 'fr' : 'en') : null;
  return { country: france ? 'FR' : place.country, region, city, provider: 'db-ip-lite', approximate: true, edition,
    display: { language, country: name(place.countryNames, language) ?? place.country,
      region: region ? name(place.regionNames, language) ?? region : null,
      city: city ? name(place.cityNames, language) ?? city : null } };
}

export function geoIpKey(raw: string): { family: '4' | '6'; key: string } | null {
  const ip = normalizePublicIp(raw);
  if (!ip) return null;
  if (!ip.includes(':')) return { family: '4', key: ip.split('.').map(v => Number(v).toString(16).padStart(2, '0')).join('') };
  if (!/^[23][0-9a-f]{3}:/.test(ip) || ip.includes('.')) return null;
  const parts = ip.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const groups = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const key = groups.map(g => g.padStart(4, '0')).join('');
  if (key.startsWith('20010db8') || key.startsWith('3fff0') || key.startsWith('2002')
    || (key.startsWith('2001') && parseInt(key.slice(4, 8), 16) < 0x0200)) return null;
  return { family: '6', key };
}
function findRange<T>(ranges: Range<T>[], key: string): Range<T> | null {
  let lo = 0; let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1; const row = ranges[mid];
    if (key < row[0]) hi = mid - 1;
    else if (key > row[1]) lo = mid + 1;
    else return row;
  }
  return null;
}
function validRanges(value: unknown, width: number, check: (v: unknown) => boolean, limit: number): boolean {
  if (!Array.isArray(value) || value.length > limit) return false;
  let end = '';
  return value.every(row => {
    if (!Array.isArray(row) || row.length !== 3 || ![row[0], row[1]].every(s => typeof s === 'string' && s.length === width && /^[0-9a-f]+$/.test(s))
      || row[0] > row[1] || row[0] <= end || !check(row[2])) return false;
    end = row[1]; return true;
  });
}
function validNames(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([lang, label]) => DBIP_LANGUAGES.includes(lang as Language) && validLabel(label));
}
function validPlace(value: unknown): value is DbipPlace {
  return isRecord(value) && typeof value.country === 'string' && /^[A-Z]{2}$/.test(value.country)
    && (value.regionCode === null || validLabel(value.regionCode))
    && validNames(value.countryNames) && validNames(value.regionNames) && validNames(value.cityNames);
}
async function checkedJson(read: ReadGeoObject, file: string, hash: string, limit: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await read(file, limit, signal);
  if (bytes.byteLength > limit) throw new Error('GEO_OBJECT_TOO_LARGE');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) throw new Error('GEO_INTEGRITY_FAILED');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** One immutable release per isolate. Cache contains public database shards, NEVER visitor IPs. */
export function createDbipLookup(config: { read: ReadGeoObject; manifestSha256: string; now?: () => number }) {
  const now = config.now ?? Date.now;
  let manifest: Promise<Manifest> | undefined;
  let unavailableUntil = 0;
  const shards = new Map<string, Shard>();
  const pending = new Map<string, Promise<Shard>>();
  const fresh = (m: Manifest) => m.databaseEpoch * 1000 <= now() + 86_400_000 && now() - m.databaseEpoch * 1000 < 100 * 86_400_000;
  return async (ip: string, acceptLanguage = ''): Promise<DbipLocation | null> => {
    const address = geoIpKey(ip);
    if (!address || !SHA.test(config.manifestSha256) || unavailableUntil > now()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const signal = controller.signal;
      manifest ??= checkedJson(config.read, 'manifest.json', config.manifestSha256, MAX_MANIFEST, signal).then(data => {
        if (!isRecord(data) || data.format !== 'forsure-dbip-lite' || typeof data.edition !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.edition)
          || typeof data.databaseEpoch !== 'number' || !Number.isSafeInteger(data.databaseEpoch) || !isRecord(data.ranges)
          || !validRanges(data.ranges['4'], 8, v => typeof v === 'string' && SHA.test(v), 60_000)
          || !validRanges(data.ranges['6'], 32, v => typeof v === 'string' && SHA.test(v), 60_000)) throw new Error('INVALID_GEO_MANIFEST');
        return data as unknown as Manifest;
      });
      const index = await manifest;
      if (!fresh(index)) return null; // Fail back to profile/manual/general content if updates stopped.
      const range = findRange(index.ranges[address.family], address.key);
      if (!range) return null;
      const id = range[2];
      let shard = shards.get(id);
      if (!shard) {
        let work = pending.get(id);
        if (!work) {
          if (pending.size >= 4) return null; // Bounded concurrent memory, never hold up the feed.
          work = checkedJson(config.read, `${id}.json`, id, MAX_SHARD, signal).then(data => {
            if (!isRecord(data) || !Array.isArray(data.places) || data.places.length > 2048 || !data.places.every(validPlace)
              || !validRanges(data.ranges, address.family === '4' ? 8 : 32, v => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < (data.places as DbipPlace[]).length, 2048)) throw new Error('INVALID_GEO_SHARD');
            const loaded = data as unknown as Shard;
            if (loaded.ranges[0]?.[0] !== range[0] || loaded.ranges.at(-1)?.[1] !== range[1]) throw new Error('INVALID_GEO_RANGE');
            if (shards.size >= 8) shards.delete(shards.keys().next().value!);
            shards.set(id, loaded); return loaded;
          });
          pending.set(id, work);
        }
        try { shard = await work; } finally { pending.delete(id); }
      }
      const entry = findRange(shard.ranges, address.key);
      return entry ? localizeDbip(shard.places[entry[2]], dbipLanguage(acceptLanguage), index.edition) : null;
    } catch {
      // Generic fallback only. Do not log an IP, key, storage URL or provider payload.
      manifest = undefined; unavailableUntil = now() + 30_000; return null;
    } finally { clearTimeout(timer); }
  };
}
