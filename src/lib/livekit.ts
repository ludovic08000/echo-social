import { supabase } from '@/integrations/supabase/client';

export async function getLiveKitToken(roomName: string, isHost: boolean) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { roomName, isHost },
  });

  if (error) throw error;
  return data as { token: string; url: string };
}
