import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.93.2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { checkRateLimit as checkRateLimitDB } from '../_shared/rate-limit.ts';

const AUDIENCE = 'forsure-voice';
const TTL_MS = 60_000;

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: 'invalid_request' }, 400); }
  const action = body.action;
  const configuredOrigin = Deno.env.get('VOICE_APP_ORIGIN') || 'https://voice.forsure.fans';
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (action === 'issue') {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json(req, { error: 'unauthorized' }, 401);
    const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error } = await authClient.auth.getUser();
    if (error || !user) return json(req, { error: 'unauthorized' }, 401);
    const limited = await checkRateLimitDB(`voice-session:${user.id}`, 10, 60, getCorsHeaders(req));
    if (limited) return limited;

    const ticket = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    const { error: insertError } = await service.from('voice_session_tickets').insert({
      ticket_hash: await sha256(ticket), user_id: user.id, nonce,
      allowed_origin: configuredOrigin, audience: AUDIENCE, expires_at: expiresAt,
    });
    if (insertError) {
      console.error('[voice-session] issue_failed', { code: insertError.code, user_id: user.id });
      return json(req, { error: 'ticket_unavailable' }, 500);
    }
    return json(req, { ticket, nonce, expires_at: expiresAt, origin: configuredOrigin });
  }

  if (action === 'exchange') {
    const suppliedSecret = req.headers.get('x-voice-service-secret');
    const expectedSecret = Deno.env.get('VOICE_SERVICE_SECRET');
    if (!expectedSecret || !suppliedSecret || suppliedSecret !== expectedSecret) {
      return json(req, { error: 'invalid_ticket' }, 401);
    }
    const ticket = typeof body.ticket === 'string' ? body.ticket : '';
    const origin = typeof body.origin === 'string' ? body.origin : '';
    if (!ticket || ticket.length > 256 || origin !== configuredOrigin) return json(req, { error: 'invalid_ticket' }, 401);
    const { data, error } = await service.rpc('consume_voice_session_ticket', {
      p_ticket_hash: await sha256(ticket), p_origin: origin, p_audience: AUDIENCE,
    });
    const consumed = Array.isArray(data) ? data[0] : data;
    if (error || !consumed) return json(req, { error: 'invalid_ticket' }, 401);
    return json(req, { user_id: consumed.user_id, nonce: consumed.nonce, permissions: consumed.permissions, audience: AUDIENCE });
  }

  return json(req, { error: 'invalid_request' }, 400);
});
