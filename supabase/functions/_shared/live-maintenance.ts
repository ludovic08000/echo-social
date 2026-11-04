import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { LIVE_MAX_DURATION_MS, liveDeadline } from './live-policy.ts';

interface RoomControl {
  listRooms(): Promise<{ name: string }[]>;
  deleteRoom(name: string): Promise<void>;
}

/** Only live rooms are eligible; call-* rooms and messaging never enter this path. */
export async function maintainLives(db: SupabaseClient, rooms: RoomControl, removeAsset: (url: string, owner: string, liveId: string) => Promise<void>, now = Date.now()) {
  const stats = { ended: 0, rooms_closed: 0, purged: 0, errors: 0 };
  const { data: timedOut, error: timeoutError } = await db.from('live_streams')
    .select('id').eq('is_active', true).lte('started_at', new Date(now - LIVE_MAX_DURATION_MS).toISOString()).limit(100);
  if (timeoutError) throw new Error('LIVE_TIMEOUT_LOOKUP_FAILED');
  for (const live of timedOut ?? []) {
    const { error } = await db.from('live_streams').update({ is_active: false }).eq('id', live.id).eq('is_active', true);
    if (error) { stats.errors++; continue; }
    stats.ended++;
  }
  for (const room of await rooms.listRooms()) {
    if (!/^live-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(room.name)) continue;
    const { data: live, error } = await db.from('live_streams').select('is_active,started_at').eq('id', room.name.slice(5)).maybeSingle();
    if (error) { stats.errors++; continue; }
    if (!live || !live.is_active || liveDeadline(live.started_at) <= now) {
      try { await rooms.deleteRoom(room.name); stats.rooms_closed++; } catch { stats.errors++; }
    }
  }
  const { data: expired, error: expiryError } = await db.from('live_streams')
    .select('id,user_id,recording_url,thumbnail_url,archive_expires_at').eq('is_active', false)
    .lte('archive_expires_at', new Date(now).toISOString()).order('archive_expires_at').limit(25);
  if (expiryError) throw new Error('LIVE_ARCHIVE_LOOKUP_FAILED');
  for (const live of expired ?? []) {
    try {
      for (const url of new Set<string>([live.recording_url, live.thumbnail_url].filter(Boolean))) {
        await removeAsset(url, live.user_id, live.id);
      }
      // Cascading FKs purge the associated live chat and view records.
      const { error } = await db.from('live_streams').delete().eq('id', live.id).eq('is_active', false)
        .eq('archive_expires_at', live.archive_expires_at);
      if (error) throw error;
      stats.purged++;
    } catch {
      stats.errors++;
      console.error('LIVE_ARCHIVE_PURGE_RETRY', { live_id: live.id });
    }
  }
  return stats;
}
