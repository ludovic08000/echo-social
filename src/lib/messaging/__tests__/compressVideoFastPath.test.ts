import { describe, expect, it, vi } from 'vitest';
import {
  SMALL_MP4_FAST_PATH_BYTES,
  compressVideoForChat,
} from '@/lib/messaging/compressVideo';

describe('compressVideoForChat instant path', () => {
  it('does not load or transcode an already-compatible small MP4', async () => {
    const clip = new Blob([new Uint8Array(1024)], { type: 'video/mp4' });
    const onProgress = vi.fn();

    const result = await compressVideoForChat(clip, onProgress);

    expect(clip.size).toBeLessThan(SMALL_MP4_FAST_PATH_BYTES);
    expect(result.blob).toBe(clip);
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('small-compatible-fast-path');
    expect(onProgress).toHaveBeenCalledWith(1);
  });
});
