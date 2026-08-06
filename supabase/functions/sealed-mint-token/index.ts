import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
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

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  try {
    const authorization = req.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'unauthorized' });

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

    const { data: authData, error: authError } = await callerClient.auth.getUser();
    const caller = authData.user;
    if (authError || !caller) return json(401, { error: 'unauthorized' });

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

    const recipientUserId = body.recipient_user_id;
    const conversationId = body.conversation_id;
    if (recipientUserId === caller.id) return json(400, { error: 'invalid_recipient' });
    if (typeof body.context_id === 'string' && utf8ByteLength(body.context_id) > 256) {
      return json(400, { error: 'context_too_large' });
    }

    const { data: conversation, error: conversationError } = await callerClient
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (conversationError || !conversation) return json(404, { error: 'conversation_not_found' });

    const { data: members, error: membersError } = await callerClient
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .in('user_id', [caller.id, recipientUserId]);
    if (membersError) return json(403, { error: 'conversation_membership_denied' });

    const memberIds = new Set((members ?? []).map(row => row.user_id));
    if (!memberIds.has(caller.id)) return json(403, { error: 'sender_not_member' });
    if (!memberIds.has(recipientUserId)) return json(403, { error: 'recipient_not_member' });

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
  } catch {
    return json(400, { error: 'invalid_request' });
  }
});
