import { supabase } from '@/integrations/supabase/client';

/**
 * Upload a file to Cloudflare R2.
 * - Small files (< 8 MB): proxied through r2-upload edge function (simple, validated)
 * - Large files (≥ 8 MB): presigned URL → direct PUT to R2 (fast, no body limit)
 */

const PRESIGN_THRESHOLD = 8 * 1024 * 1024; // 8 MB

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
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

  // Large files → presigned direct upload
  if (file.size >= PRESIGN_THRESHOLD) {
    return uploadPresigned(file, category, fileName, session.access_token, onProgress);
  }

  // Small files → proxy (existing path)
  return uploadProxy(file, category, fileName, session.access_token, onProgress);
}

// ─── Presigned direct upload ───
async function uploadPresigned(
  file: File | Blob,
  folder: string,
  filename: string,
  token: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ url: string; path: string }> {
  // 1. Get presigned URL from edge function
  const { data, error } = await supabase.functions.invoke<{
    uploadUrl: string;
    fileUrl: string;
    path: string;
  }>('r2-presign', {
    body: {
      folder,
      filename,
      contentType: file.type || 'application/octet-stream',
      fileSize: file.size,
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data?.uploadUrl) {
    throw new Error((error as any)?.message || 'Impossible d\'obtenir l\'URL d\'upload');
  }

  // 2. Upload directly to R2 with progress via XHR
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', data.uploadUrl, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

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

// ─── Proxy upload (small files) ───
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

  // Simulate progress for proxy uploads (no real XHR progress through SDK)
  onProgress?.({ loaded: 0, total: file.size, percent: 10 });

  const { data, error } = await supabase.functions.invoke<{ url: string; path: string }>('r2-upload', {
    body: formData,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!error && data?.url && data?.path) {
    onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
    return data;
  }

  // Fallback: direct fetch
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const response = await fetch(
    `https://${projectId}.supabase.co/functions/v1/r2-upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: publishableKey,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload failed: ${response.status}`);
  }

  const result = await response.json();
  onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
  return result;
}

/**
 * Delete a file from R2 via the r2-upload edge function.
 */
export async function deleteFromR2(filePath: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const { error } = await supabase.functions.invoke('r2-upload', {
    method: 'DELETE',
    body: { path: filePath },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (!error) return;

  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const response = await fetch(
    `https://${projectId}.supabase.co/functions/v1/r2-upload`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: filePath }),
    }
  );

  if (!response.ok) {
    console.error('R2 delete failed:', response.status);
  }
}
