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
    const { data, error } = await cloud.rpc('partner_media_thumbnail_source', { p_item: itemId });
    if (error) throw error;
    return typeof data === 'string' ? data : null;
  },
}));
