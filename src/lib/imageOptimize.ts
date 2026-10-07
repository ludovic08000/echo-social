/**
 * Builds fast image delivery URLs without adding an Edge Function hop.
 *
 * R2 and other CDN URLs are returned unchanged so the browser can hit the
 * media CDN directly. Supabase's native image renderer is used only when the
 * deployment explicitly enables it; this avoids broken images on plans where
 * image transformations are unavailable.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const SUPABASE_IMAGE_TRANSFORMATIONS_ENABLED =
  import.meta.env.VITE_SUPABASE_IMAGE_TRANSFORMATIONS_ENABLED === 'true';

interface ImageOptions {
  width?: number;
  height?: number;
  quality?: number;
}

interface SupabaseTransformConfig {
  supabaseUrl?: string;
  enabled?: boolean;
}

const PUBLIC_OBJECT_PATH = '/storage/v1/object/public/';
const PUBLIC_RENDER_PATH = '/storage/v1/render/image/public/';

export function buildSupabaseImageTransformUrl(
  originalUrl: string,
  options: ImageOptions,
  config: SupabaseTransformConfig = {},
): string {
  const supabaseUrl = config.supabaseUrl?.replace(/\/$/, '') ?? SUPABASE_URL;
  const enabled = config.enabled ?? SUPABASE_IMAGE_TRANSFORMATIONS_ENABLED;
  if (!enabled || !supabaseUrl) return originalUrl;

  try {
    const source = new URL(originalUrl);
    const backend = new URL(supabaseUrl);
    if (
      source.origin !== backend.origin ||
      !source.pathname.startsWith(PUBLIC_OBJECT_PATH)
    ) {
      return originalUrl;
    }

    const objectPath = source.pathname.slice(PUBLIC_OBJECT_PATH.length);
    if (!objectPath) return originalUrl;

    const rendered = new URL(`${PUBLIC_RENDER_PATH}${objectPath}`, backend.origin);
    if (options.width) rendered.searchParams.set('width', String(options.width));
    if (options.height) rendered.searchParams.set('height', String(options.height));
    if (options.quality) rendered.searchParams.set('quality', String(options.quality));
    rendered.searchParams.set('resize', 'contain');
    return rendered.toString();
  } catch {
    return originalUrl;
  }
}

/**
 * Generate an optimized image URL for avatars, post images, etc.
 * Falls back to original URL if no project ID is available.
 */
export function optimizedImageUrl(originalUrl: string | null | undefined, options: ImageOptions = {}): string | null {
  if (!originalUrl) return null;
  
  // Skip optimization for SVGs, data URLs, or already-optimized URLs
  if (
    originalUrl.startsWith('data:') ||
    originalUrl.endsWith('.svg')
  ) {
    return originalUrl;
  }

  return buildSupabaseImageTransformUrl(originalUrl, options);
}

/** Common presets */
export const imagePresets = {
  avatar: (url: string | null) => optimizedImageUrl(url, { width: 96, height: 96, quality: 85 }),
  avatarLarge: (url: string | null) => optimizedImageUrl(url, { width: 256, height: 256, quality: 85 }),
  postThumbnail: (url: string | null) => optimizedImageUrl(url, { width: 680, quality: 80 }),
  coverImage: (url: string | null) => optimizedImageUrl(url, { width: 1200, quality: 75 }),
} as const;
