import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.117.0';
import { getCorsHeaders } from '../_shared/cors.ts';

type JsonObject = Record<string, unknown>;

function respond(req: Request, status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function boundedText(input: JsonObject, field: string, maxBytes: number): string {
  const value = input[field];
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return new TextEncoder().encode(normalized).byteLength <= maxBytes ? normalized : '';
}

function passwordValue(input: JsonObject): string {
  const value = input.password;
  if (typeof value !== 'string') return '';
  const length = new TextEncoder().encode(value).byteLength;
  return length >= 1 && length <= 1024 ? value : '';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return respond(req, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !anonKey || !serviceRoleKey) {
    return respond(req, 503, { ok: false, code: 'IDENTITY_RESET_UNAVAILABLE' });
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return respond(req, 401, { ok: false, code: 'NOT_AUTHENTICATED' });
  }

  const callerToken = authorization.slice('Bearer '.length).trim();
  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });
  const passwordVerifier = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data: callerData, error: callerError } = await authClient.auth.getUser(callerToken);
  const caller = callerData.user;
  if (callerError || !caller?.id || !caller.email) {
    return respond(req, 401, { ok: false, code: 'NOT_AUTHENTICATED' });
  }

  // Password possession alone is not enough after a suspicious login. During
  // staged rollout this RPC returns true while enforcement is disabled; once
  // enabled it binds the reset to this exact, separately approved auth session.
  const { data: loginApproved, error: loginApprovalError } = await authClient
    .rpc('is_current_login_session_approved');
  if (loginApprovalError || loginApproved !== true) {
    return respond(req, 403, { ok: false, code: 'LOGIN_SECURITY_APPROVAL_REQUIRED' });
  }

  let input: JsonObject;
  try {
    input = await req.json() as JsonObject;
  } catch {
    return respond(req, 400, { ok: false, code: 'INVALID_JSON' });
  }

  const password = passwordValue(input);
  const identityKey = boundedText(input, 'identity_key', 128);
  const signingKey = boundedText(input, 'signing_key', 128);
  const fingerprint = boundedText(input, 'fingerprint', 160);
  const bindingSignature = boundedText(input, 'binding_signature', 256);
  const bindingVersion = input.binding_version;

  if (
    !password || !identityKey || !signingKey || !fingerprint || !bindingSignature ||
    bindingVersion !== 1
  ) {
    return respond(req, 400, { ok: false, code: 'IDENTITY_RESET_INPUT_INVALID' });
  }

  // Password proof is deliberately performed server-side. The browser cannot
  // call the privileged replacement RPC and cannot claim that reauthentication
  // succeeded. The temporary session is never persisted or returned.
  const { data: passwordData, error: passwordError } =
    await passwordVerifier.auth.signInWithPassword({
      email: caller.email,
      password,
    });
  if (passwordError || passwordData.user?.id !== caller.id) {
    return respond(req, 403, { ok: false, code: 'INVALID_PASSWORD' });
  }

  const { data, error } = await admin.rpc('replace_unrecoverable_identity_v2', {
    p_user_id: caller.id,
    p_identity_key: identityKey,
    p_signing_key: signingKey,
    p_fingerprint: fingerprint,
    p_binding_version: 1,
    p_binding_signature: bindingSignature,
  });

  if (error) {
    return respond(req, 409, { ok: false, code: 'IDENTITY_RESET_REJECTED' });
  }

  const result = data as JsonObject | null;
  if (!result || result.ok !== true) {
    const code = typeof result?.code === 'string' ? result.code : 'IDENTITY_RESET_REJECTED';
    const status = code === 'RECOVERABLE_BACKUP_EXISTS' ? 409 : 422;
    return respond(req, status, { ok: false, code });
  }

  return respond(req, 200, result);
});
