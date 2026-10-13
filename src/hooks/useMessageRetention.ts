import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isMessageExpired, type RetainedMessage } from '@/lib/messaging/messageRetention';
import { registerPlaintextRetention } from '@/lib/crypto/plaintextStore';
import { purgeMessageLocalState } from '@/lib/messaging/messageLocalCleanup';

/** Les tombstones ne contiennent aucun texte : ils effacent les caches d'un
 * appareil absent lors de l'expiration, sans ressusciter une archive restaurée. */
export function useMessageRetention(userId?: string) {
  const client = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let syncing = false;
    const handled = new Set<string>();
    const erasing = new Set<string>();
    const erase = async (id: string, expiredAt: number) => {
      if (erasing.has(id) || cancelled) return;
      erasing.add(id);
      try {
      let existing: RetainedMessage | undefined;
      for (const [key, data] of client.getQueriesData<RetainedMessage[]>({ queryKey: ['messages'] })) {
        if (key[2] !== userId || !Array.isArray(data)) continue;
        existing ??= data.find(message => message.id === id);
      }
      if (!existing) {
        for (const [, rows] of client.getQueriesData<Array<{ last_message?: RetainedMessage }>>({ queryKey: ['conversations', userId] })) {
          existing ??= rows?.find(row => row.last_message?.id === id)?.last_message;
        }
      }
      for (const [key, data] of client.getQueriesData<RetainedMessage[]>({ queryKey: ['messages'] })) {
        if (key[2] !== userId || !Array.isArray(data)) continue;
        if (data.some(message => message.id === id)) client.setQueryData(key, data.filter(message => message.id !== id));
      }
      client.setQueriesData<Array<{ last_message?: RetainedMessage }>>({ queryKey: ['conversations', userId] }, rows =>
        rows?.map(row => row.last_message?.id === id ? { ...row, last_message: undefined } : row));
      if (handled.has(id)) return;
      await Promise.all([
        registerPlaintextRetention(id, existing?.body, expiredAt),
        purgeMessageLocalState({ messageId: id, body: existing?.body, imageUrl: existing?.image_url }),
      ]);
      if (cancelled) return;
      handled.add(id);
      if (handled.size > 5000) handled.delete(handled.values().next().value!);
      // Une prévisualisation de conversation ne doit pas conserver le texte expiré.
      client.setQueriesData<Array<{ last_message?: RetainedMessage }>>({ queryKey: ['conversations', userId] }, rows =>
        rows?.map(row => row.last_message?.id === id ? { ...row, last_message: undefined } : row));
      } finally { erasing.delete(id); }
    };
    const prune = () => {
      client.setQueriesData<Array<{ last_message?: RetainedMessage }>>({ queryKey: ['conversations', userId] }, rows => {
        if (!rows?.some(row => row.last_message?.id && handled.has(row.last_message.id))) return rows;
        return rows.map(row => row.last_message?.id && handled.has(row.last_message.id) ? { ...row, last_message: undefined } : row);
      });
      for (const [key, data] of client.getQueriesData<RetainedMessage[]>({ queryKey: ['messages'] })) {
        if (key[2] !== userId || !Array.isArray(data)) continue;
        for (const message of data) if (handled.has(message.id) || isMessageExpired(message)) {
          void erase(message.id, handled.has(message.id) ? Date.now() : Date.parse(message.expires_at!)).catch(() => {});
        }
      }
    };
    const synchronize = async () => {
      if (syncing || cancelled) return;
      syncing = true;
      try {
        for (let offset = 0; !cancelled; offset += 250) {
          const { data, error } = await supabase.from('message_expiration_tombstones' as never)
            .select('message_id,expired_at').eq('user_id', userId).order('message_id').range(offset, offset + 249);
          if (error || cancelled) return; // Une erreur n'est jamais une preuve de suppression.
          const rows = data as unknown as Array<{ message_id: string; expired_at: string }>;
          for (const row of rows ?? []) {
            const at = Date.parse(row.expired_at);
            if (Number.isFinite(at)) await erase(row.message_id, Math.min(Date.now(), at));
          }
          if (!rows || rows.length < 250) break;
        }
        const cached = client.getQueriesData<RetainedMessage[]>({ queryKey: ['messages'] })
          .filter(([key]) => key[2] === userId).flatMap(([, rows]) => Array.isArray(rows) ? rows : [])
          .filter(row => row.retention_after_read_seconds != null);
        const ids = [...new Set(cached.map(row => row.id))];
        for (let i = 0; i < ids.length && !cancelled; i += 100) {
          const { data, error } = await supabase.from('messages').select('id,expires_at')
            .in('id', ids.slice(i, i + 100));
          if (error || cancelled) return;
          for (const row of data ?? []) {
            for (const [key, rows] of client.getQueriesData<RetainedMessage[]>({ queryKey: ['messages'] })) {
              if (key[2] !== userId || !Array.isArray(rows)) continue;
              if (rows.some(m => m.id === row.id && m.expires_at !== row.expires_at)) {
                const message = rows.find(m => m.id === row.id)!;
                await registerPlaintextRetention(row.id, message.body, row.expires_at ? Date.parse(row.expires_at) : null);
                client.setQueryData(key, rows.map(m => m.id === row.id ? { ...m, expires_at: row.expires_at } : m));
              }
            }
          }
        }
        prune();
      } finally { syncing = false; }
    };
    const onReturn = () => { if (!document.hidden) { prune(); void synchronize().catch(() => {}); } };
    const channel = supabase.channel(`aegis-expiration-${userId}`).on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'message_expiration_tombstones', filter: `user_id=eq.${userId}`,
    }, payload => {
      const row = payload.new as { message_id?: string; expired_at?: string };
      const at = Date.parse(row.expired_at ?? '');
      if (row.message_id && Number.isFinite(at)) void erase(row.message_id, Math.min(Date.now(), at)).catch(() => {});
    }).subscribe();
    void synchronize().catch(() => {});
    const expiryTimer = setInterval(prune, 1000);
    const syncTimer = setInterval(() => void synchronize().catch(() => {}), 60000);
    window.addEventListener('online', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
      clearInterval(expiryTimer); clearInterval(syncTimer);
      window.removeEventListener('online', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [client, userId]);
}
