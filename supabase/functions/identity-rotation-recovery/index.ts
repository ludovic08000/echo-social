import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.2';
import { getCorsHeaders } from '../_shared/cors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/u;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
type RecoveryAction = 'attach' | 'fetch' | 'finalize';

type RecoveryRow = {
  id: string;
  next_epoch: number;
  proposed_fingerprint: string;
  approver_device_id: string;
  committed_at: string | null;
  recovery_blob: string | null;
  recovery_iv: string | null;
  recovery_blob_version: number | null;
};

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
  return encoder.encode(normalized).byteLength <= maxBytes ? normalized : '';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return respond(req, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !anonKey || !serviceRoleKey) {
    return respond(req, 503, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_UNAVAILABLE' });
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return respond(req, 401, { ok: false, code: 'NOT_AUTHENTICATED' });
  }

  const token = authorization.slice('Bearer '.length).trim();
  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const user = userData.user;
  if (userError || !user) return respond(req, 401, { ok: false, code: 'NOT_AUTHENTICATED' });

  let input: JsonObject;
  try {
    input = await req.json() as JsonObject;
  } catch {
    return respond(req, 400, { ok: false, code: 'INVALID_JSON' });
  }

  const actionValue = input.action;
  const action = typeof actionValue === 'string' &&
    ['attach', 'fetch', 'finalize'].includes(actionValue)
    ? actionValue as RecoveryAction
    : null;
  if (!action) return respond(req, 400, { ok: false, code: 'INVALID_ACTION' });

  try {
    if (action === 'fetch') {
      const { data, error } = await admin
        .from('identity_rotation_requests')
        .select('id,next_epoch,proposed_fingerprint,approver_device_id,committed_at,recovery_blob,recovery_iv,recovery_blob_version')
        .eq('user_id', user.id)
        .not('committed_at', 'is', null)
        .not('recovery_blob', 'is', null)
        .order('committed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = data as RecoveryRow | null;
      if (error || !row || !row.committed_at || !row.recovery_blob || !row.recovery_iv) {
        return respond(req, 404, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_NOT_FOUND' });
      }
      return respond(req, 200, {
        ok: true,
        code: 'IDENTITY_ROTATION_RECOVERY_AVAILABLE',
        rotation_id: row.id,
        identity_epoch: row.next_epoch,
        fingerprint: row.proposed_fingerprint,
        surviving_device_id: row.approver_device_id,
        recovery_blob: row.recovery_blob,
        recovery_iv: row.recovery_iv,
        recovery_blob_version: row.recovery_blob_version,
      });
    }

    const rotationId = boundedText(input, 'rotation_id', 64);
    if (!UUID_RE.test(rotationId)) {
      return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_ID_INVALID' });
    }

    if (action === 'finalize') {
      const { data, error } = await admin.rpc('finalize_identity_rotation_recovery_v1', {
        p_user_id: user.id,
        p_rotation_id: rotationId,
      });
      if (error) {
        return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_FINALIZE_REJECTED' });
      }
      return respond(req, 200, data as JsonObject);
    }

    const recoveryBlob = boundedText(input, 'recovery_blob', 131072);
    const recoveryIv = boundedText(input, 'recovery_iv', 64);
    const recoveryVersion = input.recovery_blob_version;
    if (
      typeof recoveryVersion !== 'number' ||
      recoveryVersion !== 1 ||
      recoveryBlob.length < 128 ||
      recoveryIv.length < 16 ||
      !BASE64_RE.test(recoveryBlob) ||
      !BASE64_RE.test(recoveryIv)
    ) {
      return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_INVALID' });
    }

    const { data, error } = await admin.rpc('attach_identity_rotation_recovery_v1', {
      p_user_id: user.id,
      p_rotation_id: rotationId,
      p_recovery_blob: recoveryBlob,
      p_recovery_iv: recoveryIv,
      p_recovery_blob_version: recoveryVersion,
    });
    if (error) {
      return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_ATTACH_REJECTED' });
    }
    return respond(req, 200, data as JsonObject);
  } catch {
    return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_REQUEST_INVALID' });
  }
});
