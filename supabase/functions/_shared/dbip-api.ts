import { frenchRegion } from './media-context.ts';
import type { CoarseLocation } from './media-location.ts';
import { normalizePublicIp } from './network-context.ts';

const MAX_RESPONSE_BYTES = 16_384;

const clean = (value: unknown, max = 100): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return null;
  return Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) ? null : normalized;
};

/**
 * HTTPS fallback for the free DB-IP endpoint. The caller supplies only an IP
 * obtained from a gateway-managed header. The response is reduced immediately
 * to a French coarse zone; the IP and coordinates are never returned or saved.
 */
export async function locateWithDbipFree(
  ip: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoarseLocation | null> {
  const publicIp = normalizePublicIp(ip);
  if (!publicIp) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_200);
  try {
    const response = await fetchImpl(`https://api.db-ip.com/v2/free/${encodeURIComponent(publicIp)}`, {
      headers: { Accept: 'application/json', 'Accept-Language': 'fr' },
      redirect: 'error',
      signal: controller.signal,
    });
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (!response.ok || (declaredSize > 0 && declaredSize > MAX_RESPONSE_BYTES)) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) return null;
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload.error) return null;
    const sourceCountry = clean(payload.countryCode, 2)?.toUpperCase() ?? '';
    if (!['FR', 'GP', 'MQ', 'GF', 'RE', 'YT'].includes(sourceCountry)) return null;
    const region = frenchRegion(sourceCountry, payload.stateProv);
    if (!region) return null;
    return { country: 'FR', region, city: clean(payload.city) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
