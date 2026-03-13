/**
 * Utility for generating optimized image URLs.
 * Uses the image-optimize edge function to serve resized/cached images.
 */

const SUPABASE_PROJECT_ID = import.meta.env.VITE_SUPABASE_PROJECT_ID;
const BASE_URL = `https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1/image-optimize`;

interface ImageOptions {
  width?: number;
  height?: number;
  quality?: number;
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
    originalUrl.endsWith('.svg') ||
    originalUrl.includes('/image-optimize')
  ) {
    return originalUrl;
  }

  // If no project ID, return original
  if (!SUPABASE_PROJECT_ID) return originalUrl;

  const params = new URLSearchParams({ url: originalUrl });
  if (options.width) params.set('w', String(options.width));
  if (options.height) params.set('h', String(options.height));
  if (options.quality) params.set('q', String(options.quality));

  return `${BASE_URL}?${params.toString()}`;
}

/** Common presets */
export const imagePresets = {
  avatar: (url: string | null) => optimizedImageUrl(url, { width: 96, height: 96, quality: 85 }),
  avatarLarge: (url: string | null) => optimizedImageUrl(url, { width: 256, height: 256, quality: 85 }),
  postThumbnail: (url: string | null) => optimizedImageUrl(url, { width: 680, quality: 80 }),
  coverImage: (url: string | null) => optimizedImageUrl(url, { width: 1200, quality: 75 }),
} as const;
