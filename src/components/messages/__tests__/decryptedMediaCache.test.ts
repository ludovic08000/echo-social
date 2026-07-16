import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDecryptedMediaCache,
  forgetDecryptedMedia,
  getDecryptedMedia,
  rememberDecryptedMedia,
  retainDecryptedMedia,
} from '../decryptedMediaCache';

describe('decryptedMediaCache lifecycle', () => {
  beforeEach(() => {
    clearDecryptedMediaCache();
    vi.restoreAllMocks();
  });

  it('does not revoke a retired URL while a mounted bubble still retains it', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    rememberDecryptedMedia('url\\x00key-a', 'blob:one', false, false);
    const release = retainDecryptedMedia('url\\x00key-a');
    expect(release).toBeTypeOf('function');

    forgetDecryptedMedia('url\\x00key-a');
    expect(getDecryptedMedia('url\\x00key-a')).toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();

    release?.();
    expect(revoke).toHaveBeenCalledWith('blob:one');
  });

  it('keeps identical encrypted URLs isolated when media keys differ', () => {
    rememberDecryptedMedia('same-url\\x00key-a', 'blob:a', false, false);
    rememberDecryptedMedia('same-url\\x00key-b', 'blob:b', true, false);
    expect(getDecryptedMedia('same-url\\x00key-a')?.objectUrl).toBe('blob:a');
    expect(getDecryptedMedia('same-url\\x00key-b')?.objectUrl).toBe('blob:b');
  });
});
