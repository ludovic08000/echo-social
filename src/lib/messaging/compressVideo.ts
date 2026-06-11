/**
 * Client-side video compression for chat attachments.
 *
 * Strategy:
 *   - Lazy-load `@ffmpeg/ffmpeg` (only when user picks a video) — the wasm
 *     core (~25 MB) never reaches users who never send videos.
 *   - Target: H.264 720p (or original if smaller), AAC 64 kbps, ~1.5 Mbps.
 *     Roughly matches WhatsApp output and stays under our 16 MB R2 cap.
 *   - Falls back to the original blob if SharedArrayBuffer is unavailable
 *     (e.g. iframe contexts without COOP/COEP headers) or any wasm error.
 *
 * IMPORTANT: this module is browser-only. Never import it from edge code.
 */
// Default targets (good Wi-Fi / 4G+).
const DEFAULT_VIDEO_BITRATE = '1500k';
const DEFAULT_AUDIO_BITRATE = '64k';
const DEFAULT_HEIGHT = 720;
// Low-bandwidth targets (mobile data, downlink < 2 Mbps).
const LOW_VIDEO_BITRATE = '600k';
const LOW_AUDIO_BITRATE = '48k';
const LOW_HEIGHT = 480;
const MAX_INPUT_BYTES = 200 * 1024 * 1024; // refuse > 200 MB inputs outright

interface EncodeTargets {
  videoBitrate: string;
  audioBitrate: string;
  height: number;
}

function pickEncodeTargets(): EncodeTargets {
  try {
    const conn = (navigator as { connection?: { downlink?: number; effectiveType?: string; saveData?: boolean } }).connection;
    const downlink = conn?.downlink ?? 10;
    const effective = conn?.effectiveType ?? '4g';
    const saveData = conn?.saveData === true;
    // Drop to 480p/600k on slow networks or when the user has enabled Save-Data.
    if (saveData || downlink < 2 || effective === '2g' || effective === 'slow-2g' || effective === '3g') {
      return { videoBitrate: LOW_VIDEO_BITRATE, audioBitrate: LOW_AUDIO_BITRATE, height: LOW_HEIGHT };
    }
  } catch { /* ignore — fall through to defaults */ }
  return { videoBitrate: DEFAULT_VIDEO_BITRATE, audioBitrate: DEFAULT_AUDIO_BITRATE, height: DEFAULT_HEIGHT };
}

let ffmpegSingleton: { ffmpeg: any; loaded: Promise<void> } | null = null;

function canRunFfmpegWasm(): boolean {
  // ffmpeg.wasm 0.12 needs SharedArrayBuffer + cross-origin isolation.
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof self !== 'undefined' &&
    (self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

async function getFfmpeg() {
  if (ffmpegSingleton) return ffmpegSingleton;
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const { toBlobURL } = await import('@ffmpeg/util');
  const ffmpeg = new FFmpeg();
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
  const loaded = ffmpeg
    .load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    .then(() => undefined);
  ffmpegSingleton = { ffmpeg, loaded };
  return ffmpegSingleton;
}

export type CompressResult = {
  blob: Blob;
  compressed: boolean;
  reason?: string;
};

/**
 * Compress a video file to H.264 720p MP4. Returns the original blob if
 * compression isn't possible (no SAB) or if the output would be larger.
 */
export async function compressVideoForChat(
  input: File | Blob,
  onProgress?: (ratio: number) => void,
): Promise<CompressResult> {
  if (input.size > MAX_INPUT_BYTES) {
    return { blob: input, compressed: false, reason: 'input-too-large' };
  }
  if (!canRunFfmpegWasm()) {
    return { blob: input, compressed: false, reason: 'no-shared-array-buffer' };
  }

  try {
    const { ffmpeg, loaded } = await getFfmpeg();
    await loaded;

    if (onProgress) {
      ffmpeg.on('progress', ({ progress }: { progress: number }) =>
        onProgress(Math.max(0, Math.min(1, progress))),
      );
    }

    const { videoBitrate, audioBitrate, height } = pickEncodeTargets();

    const inName = 'in.mp4';
    const outName = 'out.mp4';
    const buf = new Uint8Array(await input.arrayBuffer());
    await ffmpeg.writeFile(inName, buf);

    await ffmpeg.exec([
      '-i', inName,
      '-vf', `scale='min(iw,trunc(oh*a/2)*2)':'min(${height},ih)'`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', videoBitrate,
      '-maxrate', videoBitrate,
      '-bufsize', '3000k',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-movflags', '+faststart',
      '-y', outName,
    ]);

    const out = await ffmpeg.readFile(outName);
    const outBytes = (out instanceof Uint8Array ? new Uint8Array(out) : new Uint8Array(out as ArrayBuffer));
    const outBlob = new Blob([outBytes.buffer as ArrayBuffer], { type: 'video/mp4' });
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});

    if (outBlob.size >= input.size) {
      return { blob: input, compressed: false, reason: 'no-savings' };
    }
    return { blob: outBlob, compressed: true };
  } catch (e) {
    return { blob: input, compressed: false, reason: `ffmpeg-error:${(e as Error).message}` };
  }
}
