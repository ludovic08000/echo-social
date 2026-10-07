export interface LoginNetworkContext {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

interface ResolveLoginNetworkContextOptions {
  ipinfoToken?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function cleanValue(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = Array.from(value.trim())
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  return normalized && normalized.length <= max ? normalized : null;
}

function normalizeCountry(value: unknown): string | null {
  const country = cleanValue(value, 2)?.toUpperCase() || null;
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

function normalizeIpv4(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;

  const [a, b, c] = octets;
  const nonPublic = a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
  return nonPublic ? null : octets.join('.');
}

function normalizeIpv6(value: string): string | null {
  const normalized = value.toLowerCase();
  if (normalized.length > 45 || !normalized.includes(':') || !/^[0-9a-f:]+$/.test(normalized)) return null;
  if (normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('2001:db8')) return null;
  try {
    new URL(`http://[${normalized}]/`);
  } catch {
    return null;
  }
  return normalized;
}

export function normalizePublicIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/^"|"$/g, '');
  const bracketed = value.match(/^\[([0-9a-f:]+)](?::\d+)?$/i);
  if (bracketed) value = bracketed[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.replace(/:\d+$/, '');
  return value.includes(':') ? normalizeIpv6(value) : normalizeIpv4(value);
}

export function readTrustedClientIp(headers: Headers): string | null {
  const direct = [headers.get('cf-connecting-ip'), headers.get('x-real-ip')];
  for (const candidate of direct) {
    const normalized = normalizePublicIp(candidate);
    if (normalized) return normalized;
  }
  const forwarded = (headers.get('x-forwarded-for') || '').split(',').map((candidate) => candidate.trim()).reverse();
  for (const candidate of forwarded) {
    const normalized = normalizePublicIp(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export async function resolveLoginNetworkContext(
  req: Request,
  options: ResolveLoginNetworkContextOptions = {},
): Promise<LoginNetworkContext> {
  const ip = readTrustedClientIp(req.headers);
  const gatewayCountry = normalizeCountry(req.headers.get('cf-ipcountry'));
  const fallback = { ip, country: gatewayCountry, region: null, city: null };
  const token = cleanValue(options.ipinfoToken, 512);
  if (!ip || !token) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, options.timeoutMs ?? 900));
  try {
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(
      `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (!response.ok) return fallback;
    const payload = await response.json() as Record<string, unknown>;
    if (payload.bogon === true) return fallback;
    return {
      ip,
      country: normalizeCountry(payload.country) || gatewayCountry,
      region: cleanValue(payload.region, 128),
      city: cleanValue(payload.city, 128),
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
