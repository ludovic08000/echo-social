import type { MatrixClient } from 'matrix-js-sdk';

/**
 * Downloads authenticated Matrix media as bytes and exposes only a local blob
 * URL to React. Callers must revoke the URL when the bubble unmounts.
 */
export async function downloadMatrixMedia(
  client: MatrixClient,
  mxcUrl: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; objectUrl: string }> {
  if (!mxcUrl.startsWith('mxc://')) throw new Error('MATRIX_MEDIA_URL_INVALID');

  const url = client.mxcUrlToHttp(
    mxcUrl,
    undefined,
    undefined,
    undefined,
    false,
    true,
    true,
  );
  if (!url) throw new Error('MATRIX_MEDIA_URL_UNRESOLVED');

  const token = client.getAccessToken();
  if (!token) throw new Error('MATRIX_ACCESS_TOKEN_MISSING');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`MATRIX_MEDIA_DOWNLOAD_${response.status}`);

  const blob = await response.blob();
  return { blob, objectUrl: URL.createObjectURL(blob) };
}

