import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { createAegisDiagnostic } from '../_shared/aegisDiagnostics.mjs';
import {
  SEALED_SENDER_PROTOCOL_VERSION,
  SEALED_SENDER_TOKEN_TTL_MS,
  encodeSignedToken,
  isUuid,
  sha256Base64Url,
  signTokenPayload,
  utf8ByteLength,
  type SealedSenderTokenPayloadV1,
} from '../_shared/sealedSenderToken.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(status: number, body: Record<string, unknown>, diagnosticId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'x-aegis-diagnostic-id': diagnosticId, 'Access-Control-Expose-Headers': 'x-aegis-diagnostic-id' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const diagnostic = createAegisDiagnostic('sealed-mint-token', {
    logLevel: Deno.env.get('AEGIS_LOG_LEVEL'), debugUntil: Deno.env.get('AEGIS_DEBUG_UNTIL'),
  });
  const json = (status: number, body: Record<string, unknown>) => {
    diagnostic.finish(status, body.error);
    return jsonResponse(status, body, diagnostic.id);
  };
  diagnostic.step('method');
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  try {
    diagnostic.step('bearer_syntax');
    const authorization = req.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'unauthorized' });

    diagnostic.step('configuration');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const tokenSecret = Deno.env.get('SEALED_SENDER_TOKEN_SECRET');
    if (
      !supabaseUrl
      || !anonKey
      || !serviceRoleKey
      || !tokenSecret
      || utf8ByteLength(tokenSecret) < 32
    ) {
      return json(503, { error: 'sealed_sender_unavailable' });
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    diagnostic.step('auth_session');
    const { data: authData, error: authError } = await callerClient.auth.getUser();
    const caller = authData.user;
    if (authError || !caller) return json(401, { error: 'unauthorized' });

    diagnostic.step('request_shape');
    const body = await req.json().catch(() => null) as {
      recipient_user_id?: unknown;
      conversation_id?: unknown;
      context_id?: unknown;
    } | null;
    if (
      !body ||
      !isUuid(body.recipient_user_id) ||
      !isUuid(body.conversation_id) ||
      (body.context_id !== undefined && body.context_id !== null && typeof body.context_id !== 'string')
    ) {
      return json(400, { error: 'invalid_request' });
    }

    diagnostic.step('recipient');
    const recipientUserId = body.recipient_user_id;
    const conversationId = body.conversation_id;
    if (recipientUserId === caller.id) return json(400, { error: 'invalid_recipient' });
    if (typeof body.context_id === 'string' && utf8ByteLength(body.context_id) > 256) {
      return json(400, { error: 'context_too_large' });
    }

    diagnostic.step('conversation_access');
    const { data: conversation, error: conversationError } = await callerClient
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (conversationError || !conversation) return json(404, { error: 'conversation_not_found' });

    diagnostic.step('membership_lookup');
    const { data: members, error: membersError } = await callerClient
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .in('user_id', [caller.id, recipientUserId]);
    if (membersError) return json(403, { error: 'conversation_membership_denied' });

    const memberIds = new Set((members ?? []).map(row => row.user_id));
    diagnostic.step('sender_membership');
    if (!memberIds.has(caller.id)) return json(403, { error: 'sender_not_member' });
    diagnostic.step('recipient_membership');
    if (!memberIds.has(recipientUserId)) return json(403, { error: 'recipient_not_member' });

    diagnostic.step('token_signing');
    const now = Date.now();
    const payload: SealedSenderTokenPayloadV1 = {
      version: SEALED_SENDER_PROTOCOL_VERSION,
      sender_user_id: caller.id,
      recipient_user_id: recipientUserId,
      conversation_id: conversationId,
      nonce: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + SEALED_SENDER_TOKEN_TTL_MS).toISOString(),
      context_id: typeof body.context_id === 'string' ? body.context_id : null,
    };
    const mac = await signTokenPayload(payload, tokenSecret);
    const token = encodeSignedToken({ payload, mac });
    const tokenHash = await sha256Base64Url(token);

    diagnostic.step('token_persistence');
    const { error: insertError } = await admin.from('sealed_sender_tokens').insert({
      token_hash: tokenHash,
      nonce: payload.nonce,
      protocol_version: payload.version,
      sender_user_id: payload.sender_user_id,
      recipient_user_id: payload.recipient_user_id,
      conversation_id: payload.conversation_id,
      context_id: payload.context_id,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
    });
    if (insertError) return json(500, { error: 'token_persistence_failed' });

    return json(200, {
      token,
      protocol_version: payload.version,
      expires_at: payload.expires_at,
      recipient_user_id: payload.recipient_user_id,
      conversation_id: payload.conversation_id,
    });
  } catch (error) {
    diagnostic.finish(400, error instanceof Error ? error.message : undefined);
    return json(400, { error: 'invalid_request' });
  }
});
