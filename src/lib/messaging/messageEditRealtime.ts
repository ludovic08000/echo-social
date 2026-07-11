import { supabase } from '@/integrations/supabase/client';
import type { QueryClient } from '@tanstack/react-query';

let channel: ReturnType<typeof supabase.channel> | null = null;
let activeUserId: string | null = null;
let refCount = 0;
const clientRefs = new Map<QueryClient, number>();

function invalidate(messageId?: string): void {
  for (const client of clientRefs.keys()) {
    void client.invalidateQueries({
      queryKey: messageId ? ['message-edit', messageId] : ['message-edit'],
    });
  }
}

export function retainMessageEditRealtime(
  userId: string,
  queryClient: QueryClient,
): () => void {
  refCount += 1;
  clientRefs.set(queryClient, (clientRefs.get(queryClient) ?? 0) + 1);

  if (!channel || activeUserId !== userId) {
    if (channel) {
      try { supabase.removeChannel(channel); } catch {}
    }
    activeUserId = userId;
    channel = supabase
      .channel(`message-edits:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_edits' },
        (payload) => invalidate((payload.new as any)?.message_id),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_edit_device_copies',
          filter: `recipient_user_id=eq.${userId}`,
        },
        () => invalidate(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_edit_archives',
          filter: `user_id=eq.${userId}`,
        },
        () => invalidate(),
      )
      .subscribe();
  }

  return () => {
    refCount = Math.max(0, refCount - 1);
    const nextClientRefs = Math.max(0, (clientRefs.get(queryClient) ?? 1) - 1);
    if (nextClientRefs === 0) clientRefs.delete(queryClient);
    else clientRefs.set(queryClient, nextClientRefs);

    if (refCount === 0 && channel) {
      try { supabase.removeChannel(channel); } catch {}
      channel = null;
      activeUserId = null;
      clientRefs.clear();
    }
  };
}
