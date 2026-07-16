/**
 * Compress an image File before E2EE encryption + upload.
 *
 * Goals:
 * - Drastically reduce upload time on mobile (a 6 MB iPhone HEIC/JPEG → ~250 KB)
 * - Keep visual quality good enough for inline chat display (max 1600px)
 * - Re-encode to JPEG for predictable size + browser support
 *
 * Returns the original file untouched if:
 * - It's not a still image (videos, gifs)
 * - It's already small (< 200 KB)
 * - Compression fails for any reason (we never break sending)
 */

const MAX_DIMENSION = 1600;
const QUALITY = 0.80;
const SKIP_BELOW_BYTES = 200 * 1024;

const STILL_IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;

// Detect WebP encoder support (all evergreen browsers; falls back to JPEG on older Safari).
let _webpSupported: boolean | null = null;
function canEncodeWebp(): boolean {
  if (_webpSupported !== null) return _webpSupported;
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    _webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch { _webpSupported = false; }
  return _webpSupported;
}

export async function compressImageForChat(file: File): Promise<File> {
  try {
    if (!STILL_IMAGE_MIME.test(file.type)) return file;
    if (file.size <= SKIP_BELOW_BYTES) return file;

    const bitmap = await loadBitmap(file);
    const { width, height } = scaleDown(bitmap.width, bitmap.height, MAX_DIMENSION);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Free the bitmap memory ASAP on browsers that support it.
    if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
      (bitmap as ImageBitmap).close();
    }

    // WebP @ 0.80 ≈ 30% smaller than JPEG @ 0.82 at equal perceived quality.
    const useWebp = canEncodeWebp();
    const outMime = useWebp ? 'image/webp' : 'image/jpeg';
    const outExt = useWebp ? '.webp' : '.jpg';

    const blob: Blob | null = await new Promise(resolve =>
      canvas.toBlob(resolve, outMime, QUALITY)
    );
    canvas.width = 1;
    canvas.height = 1;
    if (!blob || blob.size >= file.size) return file;

    const newName = file.name.replace(/\.(heic|heif|png|webp|jpe?g)$/i, '') + outExt;
    return new File([blob], newName, { type: outMime, lastModified: Date.now() });
  } catch {
    return file;
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch { /* fall through */ }
  }
  // Fallback for browsers/files where createImageBitmap fails (e.g. some HEIC).
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scaleDown(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = w > h ? max / w : max / h;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}
