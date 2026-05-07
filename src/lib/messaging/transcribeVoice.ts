/**
 * Client wrapper around the `voice-transcribe` edge function.
 *
 * Returns the transcript or null on error. The audio bytes are never
 * persisted server-side — the edge function streams them directly to the
 * AI gateway and forgets them.
 */
import { supabase } from '@/integrations/supabase/client';

export async function transcribeVoice(blob: Blob, langHint?: string): Promise<string | null> {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Inline base64 to avoid extra deps. ~33% size overhead — safe for the
    // 8 MB cap enforced by the edge function.
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const audio_base64 = btoa(bin);
    const { data, error } = await supabase.functions.invoke('voice-transcribe', {
      body: { audio_base64, mime: blob.type || 'audio/webm', lang_hint: langHint || 'auto' },
    });
    if (error) return null;
    const transcript = (data as { transcript?: string } | null)?.transcript;
    return transcript ?? null;
  } catch {
    return null;
  }
}
