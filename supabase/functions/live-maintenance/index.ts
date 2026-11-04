import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { RoomServiceClient } from 'npm:livekit-server-sdk@2';
import { requireAdmin } from '../_shared/auth-guard.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { maintainLives } from '../_shared/live-maintenance.ts';
import { removeLiveArchiveAsset } from '../_shared/live-archive-storage.ts';

Deno.serve(async req => {
  const headers = { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers });
  const guard = await requireAdmin(req, headers);
  if (!guard.ok) return guard.response;
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const url = new URL(Deno.env.get('LIVEKIT_URL')!);
    if (!['https:', 'wss:'].includes(url.protocol)) throw new Error('LIVEKIT_CONFIGURATION_INVALID');
    url.protocol = 'https:';
    const rooms = new RoomServiceClient(url.origin, Deno.env.get('LIVEKIT_API_KEY')!, Deno.env.get('LIVEKIT_API_SECRET')!);
    const stats = await maintainLives(db, rooms, (url, owner, id) => removeLiveArchiveAsset(db, url, owner, id));
    console.log('LIVE_MAINTENANCE', stats);
    return new Response(JSON.stringify(stats), { status: stats.errors ? 503 : 200, headers });
  } catch {
    console.error('LIVE_MAINTENANCE_FAILED');
    return new Response(JSON.stringify({ error: 'LIVE_MAINTENANCE_FAILED' }), { status: 503, headers });
  }
});
