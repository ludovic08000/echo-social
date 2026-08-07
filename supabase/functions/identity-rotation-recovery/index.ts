import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.2';
import { getCorsHeaders } from '../_shared/cors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/u;
const PROOF_MAX_AGE_MS = 60_000;
const PROOF_FUTURE_SKEW_MS = 15_000;
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

type RecoveryDeviceRow = {
  device_id: string;
  device_signing_key: string | null;
  approval_status: string;
  is_active: boolean;
  revoked_at: string | null;
  crypto_invalid_at: string | null;
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

function decodeBase64(value: string, expectedLength: number): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw new Error('BASE64_INVALID');
  }
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.byteLength !== expectedLength) throw new Error('BASE64_LENGTH_INVALID');
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  );
}

async function verifyEd25519(
  publicKeyBase64: string,
  signatureBase64: string,
  payload: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      decodeBase64(publicKeyBase64, 32),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      decodeBase64(signatureBase64, 64),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

function accessProofPayload(args: {
  action: RecoveryAction;
  userId: string;
  deviceId: string;
  rotationId: string | null;
  issuedAt: string;
  recoveryDigest: string | null;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-identity-rotation-recovery-access',
    version: 1,
    action: args.action,
    userId: args.userId,
    deviceId: args.deviceId,
    rotationId: args.rotationId,
    issuedAt: args.issuedAt,
    recoveryDigest: args.recoveryDigest,
  });
}

function proofTimeValid(issuedAt: string): boolean {
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) return false;
  const now = Date.now();
  return issuedAtMs <= now + PROOF_FUTURE_SKEW_MS && now - issuedAtMs <= PROOF_MAX_AGE_MS;
}

function trustedRecoveryDevice(
  device: RecoveryDeviceRow | null,
  expectedDeviceId: string,
): device is RecoveryDeviceRow & { device_signing_key: string } {
  return Boolean(
    device &&
    device.device_id === expectedDeviceId &&
    device.device_signing_key &&
    device.approval_status === 'approved' &&
    device.is_active === true &&
    !device.revoked_at &&
    !device.crypto_invalid_at,
  );
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

  const deviceId = boundedText(input, 'device_id', 80);
  const proofIssuedAt = boundedText(input, 'proof_issued_at', 64);
  const proofSignature = boundedText(input, 'proof_signature', 256);
  if (
    !DEVICE_ID_RE.test(deviceId) ||
    !proofTimeValid(proofIssuedAt) ||
    !BASE64_RE.test(proofSignature)
  ) {
    return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_PROOF_INVALID' });
  }

  try {
    const rotationId = action === 'fetch'
      ? null
      : boundedText(input, 'rotation_id', 64);
    if (action !== 'fetch' && (!rotationId || !UUID_RE.test(rotationId))) {
      return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_ID_INVALID' });
    }

    let recoveryBlob = '';
    let recoveryIv = '';
    let recoveryVersion = 0;
    let recoveryDigest: string | null = null;
    if (action === 'attach') {
      recoveryBlob = boundedText(input, 'recovery_blob', 131072);
      recoveryIv = boundedText(input, 'recovery_iv', 64);
      const versionValue = input.recovery_blob_version;
      recoveryVersion = typeof versionValue === 'number' ? versionValue : 0;
      if (
        recoveryVersion !== 1 ||
        recoveryBlob.length < 128 ||
        recoveryIv.length < 16 ||
        !BASE64_RE.test(recoveryBlob) ||
        !BASE64_RE.test(recoveryIv)
      ) {
        return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_INVALID' });
      }
      recoveryDigest = await sha256Base64Url(
        JSON.stringify({ recoveryBlob, recoveryIv, recoveryVersion }),
      );
    }

    const rotationQuery = admin
      .from('identity_rotation_requests')
      .select('id,next_epoch,proposed_fingerprint,approver_device_id,committed_at,recovery_blob,recovery_iv,recovery_blob_version')
      .eq('user_id', user.id);
    const rotationResult = action === 'fetch'
      ? await rotationQuery
        .not('committed_at', 'is', null)
        .not('recovery_blob', 'is', null)
        .order('committed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      : await rotationQuery
        .eq('id', rotationId as string)
        .maybeSingle();
    const row = rotationResult.data as RecoveryRow | null;
    if (rotationResult.error || !row) {
      return respond(req, 404, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_NOT_FOUND' });
    }
    if (row.approver_device_id !== deviceId) {
      return respond(req, 403, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_DEVICE_MISMATCH' });
    }

    const { data: deviceData, error: deviceError } = await admin
      .from('user_devices')
      .select('device_id,device_signing_key,approval_status,is_active,revoked_at,crypto_invalid_at')
      .eq('user_id', user.id)
      .eq('device_id', deviceId)
      .maybeSingle();
    const device = deviceData as RecoveryDeviceRow | null;
    if (deviceError || !trustedRecoveryDevice(device, deviceId)) {
      return respond(req, 403, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_DEVICE_NOT_TRUSTED' });
    }

    const proofValid = await verifyEd25519(
      device.device_signing_key,
      proofSignature,
      accessProofPayload({
        action,
        userId: user.id,
        deviceId,
        rotationId: action === 'fetch' ? null : row.id,
        issuedAt: proofIssuedAt,
        recoveryDigest,
      }),
    );
    if (!proofValid) {
      return respond(req, 422, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_DEVICE_PROOF_INVALID' });
    }

    if (action === 'fetch') {
      if (!row.committed_at || !row.recovery_blob || !row.recovery_iv) {
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

    if (action === 'finalize') {
      const { data, error } = await admin.rpc('finalize_identity_rotation_recovery_v1', {
        p_user_id: user.id,
        p_rotation_id: row.id,
      });
      if (error) {
        return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_RECOVERY_FINALIZE_REJECTED' });
      }
      return respond(req, 200, data as JsonObject);
    }

    const { data, error } = await admin.rpc('attach_identity_rotation_recovery_v1', {
      p_user_id: user.id,
      p_rotation_id: row.id,
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
