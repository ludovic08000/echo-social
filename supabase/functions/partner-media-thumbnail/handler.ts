const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 6_000;
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export interface PartnerThumbnailDeps {
  lookup(itemId: string): Promise<string | null>;
  fetcher?: typeof fetch;
}

const errorResponse = (status: number, code: string, allow?: string) => new Response(
  JSON.stringify({ error: code }),
  { status, headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(allow ? { Allow: allow } : {}),
  } },
);

function trustedSource(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const localName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
    const literalAddress = host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !host.includes('.') || localName || literalAddress) return null;
    return url.toString();
  } catch { return null; }
}

async function readImage(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('EMPTY_IMAGE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

const startsWith = (data: Uint8Array, bytes: number[], offset = 0) => bytes.every((byte, index) => data[offset + index] === byte);
function hasImageSignature(data: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') return startsWith(data, [0xff, 0xd8, 0xff]);
  if (contentType === 'image/png') return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contentType === 'image/gif') return startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  if (contentType === 'image/webp') return startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8);
  if (contentType === 'image/avif') {
    if (!startsWith(data, [0x66, 0x74, 0x79, 0x70], 4)) return false;
    const header = new TextDecoder().decode(data.slice(8, Math.min(64, data.length)));
    return header.includes('avif') || header.includes('avis');
  }
  return false;
}

export function partnerMediaThumbnailHandler(deps: PartnerThumbnailDeps) {
  const fetcher = deps.fetcher ?? fetch;
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') return errorResponse(405, 'METHOD_NOT_ALLOWED', 'GET');
    const itemId = new URL(request.url).searchParams.get('id') ?? '';
    if (!ITEM_ID.test(itemId)) return errorResponse(400, 'INVALID_ITEM');

    let storedSource: string | null;
    try { storedSource = await deps.lookup(itemId); }
    catch { return errorResponse(503, 'LOOKUP_UNAVAILABLE'); }
    if (!storedSource) return errorResponse(404, 'THUMBNAIL_NOT_FOUND');
    const source = trustedSource(storedSource);
    if (!source) return errorResponse(404, 'THUMBNAIL_NOT_FOUND');

    let upstream: Response;
    try {
      const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
      upstream = await fetcher(source, {
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': 'ForSureMedia/1.0 (+https://forsure.fans)' },
        redirect: 'error',
        ...(timeout ? { signal: timeout } : {}),
      });
    } catch { return errorResponse(502, 'THUMBNAIL_FETCH_FAILED'); }
    if (!upstream.ok) { await upstream.body?.cancel().catch(() => undefined); return errorResponse(502, 'THUMBNAIL_FETCH_FAILED'); }

    const contentType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const contentLength = Number(upstream.headers.get('content-length') ?? 0);
    if (!IMAGE_TYPES.has(contentType)) { await upstream.body?.cancel().catch(() => undefined); return errorResponse(415, 'UNSUPPORTED_IMAGE'); }
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(413, 'IMAGE_TOO_LARGE');
    }
    let image: Uint8Array;
    try { image = await readImage(upstream); }
    catch (error) { return errorResponse(error instanceof Error && error.message === 'IMAGE_TOO_LARGE' ? 413 : 502, 'INVALID_IMAGE'); }
    if (!hasImageSignature(image, contentType)) return errorResponse(415, 'INVALID_IMAGE');

    const body = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
    return new Response(body, { status: 200, headers: {
      'Content-Type': contentType,
      'Content-Length': String(image.byteLength),
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      'CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept',
    } });
  };
}
