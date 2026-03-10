import { isAppleMobileWebKit } from './platform';

/**
 * MIME types that iOS Safari (WebKit) can decode natively.
 * WebM / VP8 / VP9 / AV1 are NOT supported on iOS ≤ 18.
 */
const IOS_SAFE_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime', // .mov
  'video/x-m4v',     // .m4v
];

/**
 * File extensions considered safe for iOS playback.
 */
const IOS_SAFE_EXTENSIONS = /\.(mp4|mov|m4v)$/i;

/**
 * Checks whether a video File can be played on the current device.
 * On iOS we reject WebM / OGG / non-H.264 containers.
 * On desktop browsers we allow everything.
 */
export function isVideoCompatible(file: File): { ok: boolean; reason?: string } {
  if (!isAppleMobileWebKit()) return { ok: true };

  const ext = file.name.split('.').pop()?.toLowerCase();
  const typeOk = IOS_SAFE_VIDEO_TYPES.some(t => file.type.startsWith(t));
  const extOk = ext ? IOS_SAFE_EXTENSIONS.test(`.${ext}`) : false;

  if (typeOk || extOk) return { ok: true };

  return {
    ok: false,
    reason: `Format vidéo non supporté sur iPhone (${file.type || ext || 'inconnu'}). Utilisez MP4 ou MOV (codec H.264).`,
  };
}

/**
 * Checks whether a video URL is likely playable on iOS.
 */
export function isVideoUrlSafeForIOS(url: string): boolean {
  if (!isAppleMobileWebKit()) return true;
  // Strip query params for extension check
  const path = url.split('?')[0].split('#')[0];
  return IOS_SAFE_EXTENSIONS.test(path);
}

/**
 * Map common video extensions → MIME type for the `<source type="">` hint.
 * Helps iOS / Android pick the correct decoder without downloading the file.
 */
const EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  ogg: 'video/ogg',
};

export function guessVideoMime(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_MIME[ext] || 'video/mp4';
}
