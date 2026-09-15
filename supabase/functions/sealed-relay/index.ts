import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { createAegisDiagnostic } from '../_shared/aegisDiagnostics.mjs';
import {
  SEALED_SENDER_MAX_HEADER_BYTES,
  SEALED_SENDER_MAX_PAYLOAD_BYTES,
  SEALED_SENDER_MAX_TAG_BYTES,
  decodeSignedToken,
  isUuid,
  sha256Base64Url,
  utf8ByteLength,
  validateTokenTime,
  verifyTokenMac,
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
  const diagnostic = createAegisDiagnostic('sealed-relay', {
    logLevel: Deno.env.get('AEGIS_LOG_LEVEL'), debugUntil: Deno.env.get('AEGIS_DEBUG_UNTIL'),
  });
  const json = (status: number, body: Record<string, unknown>) => {
    diagnostic.finish(status, body.error);
    return jsonResponse(status, body, diagnostic.id);
  };
  diagnostic.step('method');
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  try {
    diagnostic.step('configuration');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const tokenSecret = Deno.env.get('SEALED_SENDER_TOKEN_SECRET');
    if (
      !supabaseUrl
      || !serviceRoleKey
      || !tokenSecret
      || utf8ByteLength(tokenSecret) < 32
    ) {
      return json(503, { error: 'sealed_sender_unavailable' });
    }

    diagnostic.step('request_shape');
    const body = await req.json().catch(() => null) as {
      token?: unknown;
      conversation_id?: unknown;
      recipient_user_id?: unknown;
      anonymous_sender_tag?: unknown;
      sealed_payload?: unknown;
      sealed_header?: unknown;
    } | null;
    if (
      !body ||
      typeof body.token !== 'string' ||
      !isUuid(body.conversation_id) ||
      !isUuid(body.recipient_user_id) ||
      typeof body.anonymous_sender_tag !== 'string' ||
      typeof body.sealed_payload !== 'string' ||
      body.sealed_header === null ||
      typeof body.sealed_header !== 'object' ||
      Array.isArray(body.sealed_header)
    ) {
      return json(400, { error: 'invalid_request' });
    }

    diagnostic.step('payload_limits');
    const headerJson = JSON.stringify(body.sealed_header);
    if (utf8ByteLength(body.anonymous_sender_tag) > SEALED_SENDER_MAX_TAG_BYTES) {
      return json(413, { error: 'sender_tag_too_large' });
    }
    if (utf8ByteLength(headerJson) > SEALED_SENDER_MAX_HEADER_BYTES) {
      return json(413, { error: 'sealed_header_too_large' });
    }
    if (utf8ByteLength(body.sealed_payload) > SEALED_SENDER_MAX_PAYLOAD_BYTES) {
      return json(413, { error: 'sealed_payload_too_large' });
    }

    diagnostic.step('token_decode');
    const signed = decodeSignedToken(body.token);
    const { payload } = signed;
    diagnostic.step('conversation_binding');
    if (payload.conversation_id !== body.conversation_id) {
      return json(403, { error: 'conversation_mismatch' });
    }
    diagnostic.step('recipient_binding');
    if (payload.recipient_user_id !== body.recipient_user_id) {
      return json(403, { error: 'recipient_mismatch' });
    }
    diagnostic.step('token_lifetime');
    const timeState = validateTokenTime(payload);
    if (timeState !== 'ok') return json(401, { error: `token_${timeState}` });
    diagnostic.step('token_mac');
    if (!(await verifyTokenMac(payload, signed.mac, tokenSecret))) {
      return json(401, { error: 'invalid_token_mac' });
    }

    diagnostic.step('token_consume_and_relay');
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const tokenHash = await sha256Base64Url(body.token);
    const { data, error } = await admin.rpc('relay_sealed_sender_v1', {
      p_token_hash: tokenHash,
      p_nonce: payload.nonce,
      p_protocol_version: payload.version,
      p_sender_user_id: payload.sender_user_id,
      p_recipient_user_id: payload.recipient_user_id,
      p_conversation_id: payload.conversation_id,
      p_context_id: payload.context_id,
      p_anonymous_sender_tag: body.anonymous_sender_tag,
      p_sealed_payload: body.sealed_payload,
      p_sealed_header: body.sealed_header,
    });

    if (error) {
      const code = typeof error.message === 'string' ? error.message : 'relay_rejected';
      if (code.includes('token_consumed')) return json(409, { error: 'token_consumed' });
      if (code.includes('token_expired')) return json(401, { error: 'token_expired' });
      diagnostic.finish(403, code);
      return json(403, { error: 'relay_rejected' });
    }

    return json(201, { message_id: data });
  } catch (error) {
    diagnostic.finish(400, error instanceof Error ? error.message : undefined);
    return json(400, { error: 'invalid_request' });
  }
});
