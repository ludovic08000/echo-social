export interface Commune { code: string; city: string; region: string; department: string; country: 'FR' }
const label = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 100 && !/[\u0000-\u001f\u007f]/.test(s);

// Proxy only the town name to the official directory, never user IDs, browser IPs or coordinates.
export async function searchCommunes(query: string, fetcher: typeof fetch = fetch): Promise<Commune[]> {
  const name = query.trim();
  if (name.length < 2 || !label(name)) throw new Error('INVALID_CITY_QUERY');
  const url = new URL('https://geo.api.gouv.fr/communes');
  url.searchParams.set(/^\d{5}$/.test(name) ? 'codePostal' : 'nom', name);
  url.searchParams.set('fields', 'nom,code,departement,region');
  url.searchParams.set('limit', '8');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetcher(url.href, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok || !response.body) throw new Error('CITY_SEARCH_UNAVAILABLE');
    const reader = response.body.getReader(); let size = 0; let text = ''; const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 32768) throw new Error('CITY_SEARCH_UNAVAILABLE');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); }
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('CITY_SEARCH_UNAVAILABLE');
    const codes = new Set<string>(); const result: Commune[] = [];
    for (const row of data.slice(0, 8)) {
      if (!row || typeof row.code !== 'string' || !/^[0-9AB]{5}$/.test(row.code) || codes.has(row.code)
        || !label(row.nom) || !label(row.region?.nom) || !label(row.departement?.nom)) continue;
      codes.add(row.code);
      result.push({ code: row.code, city: row.nom, region: row.region.nom, department: row.departement.nom, country: 'FR' });
    }
    return result;
  } finally { clearTimeout(timer); }
}
