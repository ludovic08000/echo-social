import { createClient } from 'npm:@supabase/supabase-js@2.117.0';
import { partnerMediaThumbnailHandler } from './handler.ts';

const cloudUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const cloud = cloudUrl && serviceKey
  ? createClient(cloudUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

Deno.serve(partnerMediaThumbnailHandler({
  lookup: async (itemId) => {
    if (!cloud) throw new Error('BACKEND_UNAVAILABLE');
    const now = new Date().toISOString();
    const { data, error } = await cloud
      .from('partner_media_items')
      .select('thumbnail_url,moderated,published_at,expires_at,media_partners!inner(active,rights_until)')
      .eq('id', itemId)
      .eq('moderated', true)
      .lte('published_at', now)
      .gt('expires_at', now)
      .eq('media_partners.active', true)
      .gt('media_partners.rights_until', now)
      .maybeSingle();
    if (error) throw error;
    return typeof data?.thumbnail_url === 'string' ? data.thumbnail_url : null;
  },
}));
