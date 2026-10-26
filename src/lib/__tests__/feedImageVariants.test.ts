import { beforeEach, describe, expect, it, vi } from 'vitest';

const compress = vi.fn();

vi.mock('@/lib/messaging/compressImage', () => ({
  compressImageForUpload: compress,
}));

describe('feed image variants', () => {
  beforeEach(() => compress.mockReset());

  it('creates a display image and a genuinely lighter thumbnail in parallel', async () => {
    const source = new File([new Uint8Array(1_000)], 'photo.jpg', { type: 'image/jpeg' });
    const display = new File([new Uint8Array(800)], 'photo.webp', { type: 'image/webp' });
    const thumbnail = new File([new Uint8Array(200)], 'photo.webp', { type: 'image/webp' });
    compress.mockResolvedValueOnce(display).mockResolvedValueOnce(thumbnail);

    const { createFeedImageVariants } = await import('../feedImageVariants');
    const result = await createFeedImageVariants(source);

    expect(compress).toHaveBeenNthCalledWith(1, source, {
      maxDimension: 1920,
      quality: 0.82,
    });
    expect(compress).toHaveBeenNthCalledWith(2, source, {
      maxDimension: 680,
      quality: 0.68,
      skipBelowBytes: 0,
    });
    expect(result.display).toBe(display);
    expect(result.thumbnail?.name).toBe('feed-thumbnail-photo.webp');
    expect(result.thumbnail?.size).toBe(200);
  });

  it('does not upload a duplicate thumbnail when savings are negligible', async () => {
    const source = new File([new Uint8Array(1_000)], 'photo.jpg', { type: 'image/jpeg' });
    const display = new File([new Uint8Array(800)], 'photo.webp', { type: 'image/webp' });
    const candidate = new File([new Uint8Array(750)], 'photo.webp', { type: 'image/webp' });
    compress.mockResolvedValueOnce(display).mockResolvedValueOnce(candidate);

    const { createFeedImageVariants } = await import('../feedImageVariants');
    await expect(createFeedImageVariants(source)).resolves.toEqual({ display, thumbnail: null });
  });
});
