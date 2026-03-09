import { supabase } from '@/integrations/supabase/client';

export async function getLiveKitToken(roomName: string, isHost: boolean) {
  // Force a fresh session to avoid stale/expired tokens
  const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError || !session) {
    // Fallback to existing session
    const { data: { session: existing } } = await supabase.auth.getSession();
    if (!existing) throw new Error('Not authenticated');
  }

  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { roomName, isHost },
  });

  if (error) throw error;
  return data as { token: string; url: string };
}
