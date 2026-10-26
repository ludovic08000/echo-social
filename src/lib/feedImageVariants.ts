import { compressImageForUpload } from '@/lib/messaging/compressImage';

const DISPLAY_MAX_DIMENSION = 1920;
const THUMBNAIL_MAX_DIMENSION = 680;

export interface FeedImageVariants {
  display: File;
  thumbnail: File | null;
}

/**
 * Builds the two public feed variants before they cross the API boundary.
 *
 * Keeping this work in the browser avoids the Edge runtime's CPU ceiling and
 * lets the API concentrate on authentication, quotas and object delivery.
 */
export async function createFeedImageVariants(file: File): Promise<FeedImageVariants> {
  const [display, thumbnailCandidate] = await Promise.all([
    compressImageForUpload(file, {
      maxDimension: DISPLAY_MAX_DIMENSION,
      quality: 0.82,
    }),
    compressImageForUpload(file, {
      maxDimension: THUMBNAIL_MAX_DIMENSION,
      quality: 0.68,
      skipBelowBytes: 0,
    }),
  ]);

  // Do not store a second object when it brings no meaningful transfer gain.
  const thumbnail = thumbnailCandidate.size < display.size * 0.9
    ? new File(
        [thumbnailCandidate],
        `feed-thumbnail-${thumbnailCandidate.name}`,
        { type: thumbnailCandidate.type, lastModified: thumbnailCandidate.lastModified },
      )
    : null;

  return { display, thumbnail };
}
