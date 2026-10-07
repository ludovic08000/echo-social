// Read-only inventory. No backend credentials, DB connection, article output or automatic enablement.
import { RSS_CATALOG, FRENCH_REGIONS } from '../supabase/functions/partner-rss-sync/catalog.ts';
import { fetchRss } from '../supabase/functions/partner-rss-sync/rss.ts';

const live = process.argv.includes('--live');
const entries = Object.entries(RSS_CATALOG);
const results = [];
let cursor = 0;
await Promise.all(Array.from({length: live ? 3 : 1}, async () => {
  while (cursor < entries.length) {
    const [key, entry] = entries[cursor++];
    const result = { key, name: entry.name, regionCode: entry.regionCode, verified: entry.verified, status: entry.verified ? 'catalogued' : 'unverified', recentItems: null };
    if (live && entry.verified) {
      try {
        // Parsing horizon only, NOT a claim that this publisher granted any rights.
        const fetched = await fetchRss({ id: key, partner_id: 'read-only-preview', lease_token: '', source_key: key,
          website_host: entry.websiteHost, allow_excerpt: false, rights_until: new Date(Date.now() + 86400000).toISOString(),
          country: 'FR', region: entry.regionCode ? FRENCH_REGIONS[entry.regionCode] : null, city: entry.city,
          etag: null, last_modified: null });
        result.status = fetched.items.length ? 'recent' : 'no_recent_items'; result.recentItems = fetched.items.length;
      } catch (error) { result.status = error.message; }
    }
    results.push(result);
  }
}));
results.sort((a,b) => a.key.localeCompare(b.key));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: live ? 'public-read-only' : 'offline-catalog',
  productionWrites: 0, sources: results, coverage: Object.entries(FRENCH_REGIONS).map(([code,name]) => ({ code,name,
    catalogued: results.filter(r => r.regionCode === code && r.verified).length,
    fresh: live ? results.filter(r => r.regionCode === code && r.status === 'recent').length : null,
  })) }, null, 2));
