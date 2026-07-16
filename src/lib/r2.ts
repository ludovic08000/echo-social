import { supabase } from '@/integrations/supabase/client';
import {
  MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
  formatAttachmentLimit,
} from '@/lib/messaging/attachmentLimits';

/**
 * Upload a file to Cloudflare R2.
 * - Small ordinary files (< 8 MiB): proxied through r2-upload.
 * - Large files and encrypted E2EE attachments: presigned direct PUT.
 */

const PRESIGN_THRESHOLD = 8 * 1024 * 1024;
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

function normalizeContentType(file: File | Blob): string {
  return file.type?.split(';')[0].trim() || DEFAULT_CONTENT_TYPE;
}

function getFunctionsBaseUrl(): string {
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  if (configuredUrl) return `${configuredUrl}/functions/v1`;

  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  if (projectId) return `https://${projectId}.supabase.co/functions/v1`;

  throw new Error('Configuration backend manquante');
}

function getFunctionHeaders(token: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (publishableKey) {
    headers.apikey = publishableKey;
  }

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  return headers;
}

async function extractFunctionError(response: Response, fallbackMessage: string): Promise<string> {
  const payload = await response.json().catch(() => null);

  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }

  return fallbackMessage;
}

export async function uploadToR2(
  file: File | Blob,
  category: string,
  customFileName?: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ url: string; path: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const fileName = customFileName || (file instanceof File ? file.name : `file-${Date.now()}.bin`);
  const contentType = normalizeContentType(file);
  const isEncryptedAttachment =
    contentType === DEFAULT_CONTENT_TYPE && /\.enc(?:\.|$)/i.test(fileName);

  if (isEncryptedAttachment && file.size > MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES) {
    throw new Error(
      `Pièce jointe chiffrée trop volumineuse : maximum ${formatAttachmentLimit(MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES)}.`,
    );
  }

  // E2EE blobs always use the direct path, even when small. This avoids the
  // proxy's multipart buffering and keeps the same MIME/size policy at all sizes.
  const shouldPreferPresignedUpload =
    category === 'stories' || isEncryptedAttachment || file.size >= PRESIGN_THRESHOLD;

  if (shouldPreferPresignedUpload) {
    try {
      return await uploadPresigned(file, category, fileName, session.access_token, onProgress);
    } catch (err) {
      if (isEncryptedAttachment) throw err;
      console.warn('Presigned upload failed, falling back to proxy:', err);
    }
  }

  return uploadProxy(file, category, fileName, session.access_token, onProgress);
}

export async function fetchR2Object(fileUrl: string): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(`${getFunctionsBaseUrl()}/r2-upload?url=${encodeURIComponent(fileUrl)}`, {
    method: 'GET',
    headers: getFunctionHeaders(session.access_token),
  });

  if (!response.ok) {
    throw new Error(await extractFunctionError(response, `Récupération média impossible: ${response.status}`));
  }

  return response;
}

// ─── Presigned direct upload ───
async function uploadPresigned(
  file: File | Blob,
  folder: string,
  filename: string,
  token: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ url: string; path: string }> {
  const contentType = normalizeContentType(file);
  const response = await fetch(`${getFunctionsBaseUrl()}/r2-presign`, {
    method: 'POST',
    headers: getFunctionHeaders(token, 'application/json'),
    body: JSON.stringify({
      folder,
      filename,
      contentType,
      fileSize: file.size,
    }),
  });

  if (!response.ok) {
    throw new Error(await extractFunctionError(response, 'Impossible d\'obtenir l\'URL d\'upload'));
  }

  const data = (await response.json()) as {
    uploadUrl: string;
    fileUrl: string;
    path: string;
  };

  if (!data?.uploadUrl || !data?.fileUrl || !data?.path) {
    throw new Error('Réponse d\'upload invalide');
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', data.uploadUrl, true);
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({
          loaded: e.loaded,
          total: e.total,
          percent: Math.round((e.loaded / e.total) * 100),
        });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload échoué (${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Erreur réseau lors de l\'upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload annulé')));

    xhr.send(file);
  });

  return { url: data.fileUrl, path: data.path };
}

// ─── Proxy upload (small ordinary files) ───
async function uploadProxy(
  file: File | Blob,
  category: string,
  fileName: string,
  token: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ url: string; path: string }> {
  const formData = new FormData();
  formData.append('file', file, fileName);
  formData.append('folder', category);

  onProgress?.({ loaded: 0, total: file.size, percent: 10 });

  const response = await fetch(`${getFunctionsBaseUrl()}/r2-upload`, {
    method: 'POST',
    headers: getFunctionHeaders(token),
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await extractFunctionError(response, `Upload failed: ${response.status}`));
  }

  const result = await response.json() as { url: string; path: string };
  if (!result?.url || !result?.path) {
    throw new Error('Réponse d\'upload invalide');
  }

  onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
  return result;
}

/** Delete a file from R2 via the r2-upload edge function. */
export async function deleteFromR2(filePath: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(`${getFunctionsBaseUrl()}/r2-upload`, {
    method: 'DELETE',
    headers: getFunctionHeaders(session.access_token, 'application/json'),
    body: JSON.stringify({ path: filePath }),
  });

  if (!response.ok) {
    throw new Error(await extractFunctionError(response, `R2 delete failed: ${response.status}`));
  }
}
