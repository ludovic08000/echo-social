import { supabase } from '@/integrations/supabase/client';

export async function getLiveKitToken(roomName: string, _isHost?: boolean) {
  // Ensure a fresh session (isHost is intentionally ignored — role is derived server-side)
  const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError || !session) {
    const { data: { session: existing } } = await supabase.auth.getSession();
    if (!existing) throw new Error('Not authenticated');
  }

  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { roomName },
  });

  if (error) throw error;
  return data as { token: string; url: string; role: 'viewer' | 'host' | 'moderator' };
}
