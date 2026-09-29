export const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;
export const BACKGROUND_ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const BACKGROUND_ACCEPT = BACKGROUND_ACCEPTED_TYPES.join(',');

const backgroundTypes = new Set<string>(BACKGROUND_ACCEPTED_TYPES);

export function validateBackgroundFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!backgroundTypes.has(file.type.toLowerCase())) {
    return 'Format non supporté. Utilisez JPEG, PNG, WebP, HEIC ou HEIF.';
  }
  if (file.size > BACKGROUND_MAX_BYTES) {
    return 'Image trop volumineuse. Taille maximale : 5 Mo.';
  }
  return null;
}
