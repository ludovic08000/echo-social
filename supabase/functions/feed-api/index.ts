import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.0';
import { createFeedHandler } from '../_shared/feed-api-handler.ts';
import { PREFERENCE_FIELDS } from '../_shared/feed-api-contract.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const fields = PREFERENCE_FIELDS.join(',');

Deno.serve(createFeedHandler({
  async authenticate(req, signal) {
    const authorization = req.headers.get('authorization');
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (authorization && (!match || authorization.length > 8192)) return null;
    const token = match?.[1];
    // La lecture reste sous le JWT du lecteur, jamais sous le rôle service.
    const caller = createClient(url, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: token ? { Authorization: `Bearer ${token}` } : {},
        fetch: (input, init) => fetch(input, { ...init, signal, redirect: 'error' }) },
    });
    let viewerId: string | null = null;
    if (token && token !== publicKey) {
      const { data, error } = await caller.auth.getUser(token);
      if (error) {
        // An unavailable identity service is not evidence of an invalid session.
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('FEED_UNAVAILABLE');
      }
      if (!data.user || data.user.role !== 'authenticated') return null;
      // getUser verifies identity, not the continued existence of the Auth session.
      // Use the same caller JWT; never accept a browser-supplied session/user id.
      const session = await caller.rpc('feed_api_session_active');
      if (session.error || typeof session.data !== 'boolean') throw new Error('FEED_UNAVAILABLE');
      if (!session.data) return null;
      viewerId = data.user.id;
    }
    return {
      viewerId,
      rpc: (name, args) => caller.rpc(name, args),
      readPreferences: () => caller.from('user_feed_preferences').select(fields).eq('user_id', viewerId!).maybeSingle(),
      async writePreferences(preferences, seedOnly) {
        const result = await caller.from('user_feed_preferences').upsert({ ...preferences, user_id: viewerId! },
          { onConflict: 'user_id', ignoreDuplicates: seedOnly }).select(fields).maybeSingle();
        // Une migration de cache concurrente ne remplace jamais un choix déjà enregistré.
        if (!result.error && seedOnly && !result.data) return caller.from('user_feed_preferences').select(fields).eq('user_id', viewerId!).maybeSingle();
        return result;
      },
    };
  },
  async rateLimit(req, viewerId, action, headers, signal) {
    // Le rôle service est limité à l'autorité de quota. Aucun contenu n'est lu avec lui.
    const quota = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal, redirect: 'error' }) },
    });
    const consume = async (key: string, max: number) => {
      const { data, error } = await quota.rpc('check_rate_limit', {
        p_key: key, p_max_requests: max, p_window_seconds: 60,
      });
      if (error || typeof data !== 'boolean') return new Response(null, { status: 503, headers });
      return data ? null : new Response(null, { status: 429, headers });
    };
    let subject = `user:${viewerId}`;
    if (!viewerId) {
      const globalLimit = await consume('feed-api:guest-global:page', 600);
      if (globalLimit) return globalLimit;
      // This secondary quota is only per-IP if the gateway replaces these headers.
      // The global ceiling is checked first, before creating any per-IP quota row.
      const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip') || 'unknown').slice(0, 128);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
      subject = `guest:${Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')}`;
    }
    return consume(`feed-api:${subject}:${action.startsWith('preferences.') ? 'preferences' : action}`,
      action === 'page' ? 120 : 60);
  },
}));
