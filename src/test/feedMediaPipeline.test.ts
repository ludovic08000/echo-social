import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const createPost = readFileSync('src/components/CreatePost.tsx', 'utf8');
const postCard = readFileSync('src/components/PostCard.tsx', 'utf8');
const r2 = readFileSync('src/lib/r2.ts', 'utf8');

describe('feed media API pipeline', () => {
  it('uploads the display image and lightweight thumbnail concurrently through the authenticated API', () => {
    expect(createPost).toContain('createFeedImageVariants(media)');
    expect(createPost).toContain("uploadToR2(thumbnail, 'thumbnails')");
    expect(createPost).toContain("uploadToR2(display, 'post-images'");
    expect(createPost).toContain('Promise.all([');
    expect(createPost).toContain('thumbnailUrl = uploadedThumbnailUrl');
    expect(r2).toContain('Authorization: `Bearer ${token}`');
  });

  it('paints the thumbnail before downloading the full feed image', () => {
    expect(postCard).toContain('post.media_thumbnail_url');
    expect(postCard).toContain('progressivePostImage === optimizedPostImage');
    expect(postCard).toContain("fullImage.decoding = 'async'");
    expect(postCard).toContain('setRenderedImageUrl(optimizedPostImage)');
  });
});
