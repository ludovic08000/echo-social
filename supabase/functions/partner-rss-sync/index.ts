import { createClient } from '@supabase/supabase-js';
import { rssHandler } from './handler.ts';
import type { RssSource } from './rss.ts';

// These are the existing Lovable Cloud runtime credentials, never browser configuration.
const cloud = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) },
});
Deno.serve(rssHandler({
  secret: Deno.env.get('PARTNER_RSS_CRON_SECRET'),
  enabled: Deno.env.get('PARTNER_RSS_ENABLED') === 'true',
  claim: async () => {
    const { data, error } = await cloud.rpc('claim_partner_rss_sources', { p_limit: 20 });
    if (error) throw error;
    return (data ?? []) as RssSource[];
  },
  finish: async (source, result) => {
    const { data, error } = await cloud.rpc('finish_partner_rss_import', {
      p_source: source.id, p_lease: source.lease_token, p_items: result.items,
      p_status: result.status, p_etag: result.etag, p_modified: result.last_modified,
      p_error: 'error' in result ? result.error : null,
    });
    if (error) { console.warn('[RSS] persistence failed', { sourceId: source.id, code: error.code }); throw error; }
    console.info('[RSS] source checked', { sourceId: source.id, status: result.status, items: result.items.length, applied: data === true });
    return data === true;
  },
}));
