import { supabase } from '@/integrations/supabase/client';

/**
 * Upload a file to Cloudflare R2 via the r2-upload edge function.
 * Files are organized as: {userId}/{category}/{timestamp}.{ext}
 */
export async function uploadToR2(
  file: File | Blob,
  category: string,
  customFileName?: string
): Promise<{ url: string; path: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const formData = new FormData();
  formData.append('file', file, customFileName || (file instanceof File ? file.name : `file-${Date.now()}.bin`));
  formData.append('folder', category);

  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const response = await fetch(
    `https://${projectId}.supabase.co/functions/v1/r2-upload`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: formData,
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Delete a file from R2 via the r2-upload edge function.
 */
export async function deleteFromR2(filePath: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const response = await fetch(
    `https://${projectId}.supabase.co/functions/v1/r2-upload`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: filePath }),
    }
  );

  if (!response.ok) {
    console.error('R2 delete failed:', response.status);
  }
}
