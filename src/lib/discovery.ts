export const AD_INTERESTS = ['Sport', 'Tech', 'Cuisine', 'Musique', 'Art', 'Gaming', 'Jardinage', 'Bricolage'] as const;

export interface DiscoveryPreferences {
  ads_profile: boolean;
  ads_activity: boolean;
  ads_location: boolean;
  ads_location_auto: boolean;
  local_media: boolean;
  country: string | null;
  region: string | null;
  city: string | null;
  updated_at?: string;
}

export const DEFAULT_DISCOVERY: DiscoveryPreferences = {
  ads_profile: false, ads_activity: false, ads_location: false, ads_location_auto: false, local_media: false,
  country: null, region: null, city: null,
};

export type MediaScope = 'nearby' | 'city' | 'region' | 'france';
export type MediaKind = 'all' | 'article' | 'video';
export interface PartnerMediaItem {
  discussion_id?: string | null;
  id: string; title: string; excerpt: string; canonical_url: string;
  kind: 'article' | 'video'; youtube_id: string | null; thumbnail_url?: string | null;
  published_at: string; source_name: string; country: string; region: string | null; city: string | null;
  proximity?: 'city' | 'region' | 'national' | 'other';
}

export function safePartnerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
      || Array.from(value).some(char => char.charCodeAt(0) < 32 || char === '\\' || char.charCodeAt(0) === 127)) return null;
    return url.href;
  } catch { return null; }
}

const PARTNER_THUMBNAIL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTNER_MEDIA_BACKEND = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '') ?? '';

export function partnerThumbnailUrl(
  itemId: string,
  available: string | null | undefined,
  backend = PARTNER_MEDIA_BACKEND,
): string | null {
  if (!available || !PARTNER_THUMBNAIL_ID.test(itemId) || !backend) return null;
  try {
    const origin = new URL(backend);
    if (origin.protocol !== 'https:' || origin.username || origin.password) return null;
    const endpoint = new URL('/functions/v1/partner-media-thumbnail', origin);
    endpoint.searchParams.set('id', itemId);
    return endpoint.toString();
  } catch { return null; }
}

export function youtubeEmbedUrl(id: string | null): string | null {
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=0` : null;
}

export function discoveryPayload(value: DiscoveryPreferences) {
  return {
    ads_profile: value.ads_profile, ads_activity: value.ads_activity,
    ads_location: value.ads_location, ads_location_auto: value.ads_location && value.ads_location_auto,
    local_media: value.local_media,
    country: value.local_media || value.ads_location ? value.country?.trim().toUpperCase() || null : null,
    region: value.local_media || value.ads_location ? value.region?.trim() || null : null,
    city: value.local_media || value.ads_location ? value.city?.trim() || null : null,
  };
}
