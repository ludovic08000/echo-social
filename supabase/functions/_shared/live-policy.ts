// Instagram's published Live policy: up to four hours, 30-day archives.
export const LIVE_MAX_DURATION_MS = 4 * 60 * 60 * 1_000;
export const LIVE_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const LIVE_END_WARNING_MS = 5 * 60 * 1_000;

export function liveDeadline(startedAt: string | null): number {
  const started = Date.parse(startedAt ?? '');
  return Number.isFinite(started) ? started + LIVE_MAX_DURATION_MS : 0;
}

/** Only full account UUID archive paths prove the intended deletion scope. */
export function liveArchiveKey(raw: string, publicBase: string, owner: string): string {
  const url = new URL(raw);
  const base = new URL(publicBase.endsWith('/') ? publicBase : `${publicBase}/`);
  if (url.origin !== base.origin || url.search || url.hash || !url.pathname.startsWith(base.pathname)) throw new Error('LIVE_ARCHIVE_ORIGIN_INVALID');
  const key = url.pathname.slice(base.pathname.length);
  if (!/^[0-9a-f-]{36}$/i.test(owner) || !key.startsWith(`${owner}/lives/`)
    || !/^\d+\.(mp4|webm|jpeg|jpg|png|webp|heic|heif)$/.test(key.slice(`${owner}/lives/`.length))) {
    throw new Error('LIVE_ARCHIVE_OWNERSHIP_UNVERIFIED');
  }
  return key;
}
