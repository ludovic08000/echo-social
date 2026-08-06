import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.2';
import { getCorsHeaders } from '../_shared/cors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
type Action = 'begin' | 'commit' | 'cancel' | 'status';

type AccountIdentityRow = {
  id: string;
  identity_key: string;
  signing_key: string;
  fingerprint: string;
  identity_binding_signature: string | null;
  identity_binding_version: number | null;
  identity_epoch: number;
  is_active: boolean;
};

type DeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string | null;
  approval_status: string;
  is_active: boolean;
  revoked_at: string | null;
  crypto_invalid_at: string | null;
};

type RotationRow = {
  id: string;
  user_id: string;
  current_epoch: number;
  next_epoch: number;
  current_fingerprint: string;
  proposed_identity_key: string;
  proposed_signing_key: string;
  proposed_fingerprint: string;
  proposed_binding_signature: string;
  proposed_binding_version: number;
  approver_device_id: string;
  reason: string;
  challenge_payload: string;
  expires_at: string;
  committed_at: string | null;
  cancelled_at: string | null;
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

function text(input: JsonObject, field: string, max = 4096): string {
  const value = input[field];
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return encoder.encode(normalized).byteLength <= max ? normalized : '';
}

function integer(input: JsonObject, field: string): number | null {
  const value = input[field];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
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

function accountBindingPayload(identityKey: string, signingKey: string): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-account-identity',
    version: 1,
    identityKey,
    signingKey,
  });
}

function deviceAuthorizationPayload(args: {
  userId: string;
  deviceId: string;
  accountFingerprint: string;
  devicePublicKey: string;
  deviceSigningKey: string;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-device-authorization',
    userId: args.userId,
    deviceId: args.deviceId,
    accountFingerprint: args.accountFingerprint,
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
  });
}

async function fingerprintForBinding(payload: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(payload)));
  let fingerprint = '';
  for (let index = 0; index < 20; index += 1) {
    if (index > 0 && index % 4 === 0) fingerprint += ' ';
    fingerprint += digest[index].toString(16).padStart(2, '0');
  }
  return fingerprint.toUpperCase();
}

function trustedDevice(device: DeviceRow | null): device is DeviceRow {
  return Boolean(
    device &&
    device.approval_status === 'approved' &&
    device.is_active === true &&
    !device.revoked_at &&
    !device.crypto_invalid_at &&
    device.device_public_key &&
    device.device_signing_key,
  );
}

async function validateProposedBinding(args: {
  identityKey: string;
  signingKey: string;
  fingerprint: string;
  bindingSignature: string;
}): Promise<boolean> {
  const payload = accountBindingPayload(args.identityKey, args.signingKey);
  const fingerprint = await fingerprintForBinding(payload);
  return fingerprint === args.fingerprint && await verifyEd25519(
    args.signingKey,
    args.bindingSignature,
    payload,
  );
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return respond(req, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !anonKey || !serviceRoleKey) {
    return respond(req, 503, { ok: false, code: 'IDENTITY_ROTATION_UNAVAILABLE' });
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

  const action = input.action as Action | undefined;
  if (!action || !['begin', 'commit', 'cancel', 'status'].includes(action)) {
    return respond(req, 400, { ok: false, code: 'INVALID_ACTION' });
  }

  try {
    if (action === 'begin') {
      const currentEpoch = integer(input, 'current_epoch');
      const currentFingerprint = text(input, 'current_fingerprint', 160);
      const proposedIdentityKey = text(input, 'proposed_identity_key', 128);
      const proposedSigningKey = text(input, 'proposed_signing_key', 128);
      const proposedFingerprint = text(input, 'proposed_fingerprint', 160);
      const proposedBindingSignature = text(input, 'proposed_binding_signature', 256);
      const approverDeviceId = text(input, 'approver_device_id', 80);
      const reason = text(input, 'reason', 120) || 'manual_rotation';

      if (
        currentEpoch === null || currentEpoch < 1 ||
        !currentFingerprint || !proposedIdentityKey || !proposedSigningKey ||
        !proposedFingerprint || !proposedBindingSignature ||
        !DEVICE_ID_RE.test(approverDeviceId)
      ) {
        return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_INPUT_INVALID' });
      }
      if (currentFingerprint === proposedFingerprint) {
        return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_FINGERPRINT_UNCHANGED' });
      }
      if (!await validateProposedBinding({
        identityKey: proposedIdentityKey,
        signingKey: proposedSigningKey,
        fingerprint: proposedFingerprint,
        bindingSignature: proposedBindingSignature,
      })) {
        return respond(req, 422, { ok: false, code: 'IDENTITY_ROTATION_NEW_BINDING_INVALID' });
      }

      const [currentResult, deviceResult] = await Promise.all([
        admin
          .from('user_public_keys')
          .select('id,identity_key,signing_key,fingerprint,identity_binding_signature,identity_binding_version,identity_epoch,is_active')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from('user_devices')
          .select('device_id,device_public_key,device_signing_key,approval_status,is_active,revoked_at,crypto_invalid_at')
          .eq('user_id', user.id)
          .eq('device_id', approverDeviceId)
          .maybeSingle(),
      ]);

      const current = currentResult.data as AccountIdentityRow | null;
      const device = deviceResult.data as DeviceRow | null;
      if (currentResult.error || !current) {
        return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_CURRENT_IDENTITY_NOT_FOUND' });
      }
      if (current.identity_epoch !== currentEpoch || current.fingerprint !== currentFingerprint) {
        return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_CURRENT_IDENTITY_CHANGED' });
      }
      if (deviceResult.error || !trustedDevice(device)) {
        return respond(req, 403, { ok: false, code: 'IDENTITY_ROTATION_APPROVER_NOT_TRUSTED' });
      }

      const { data, error } = await admin.rpc('begin_identity_rotation_v1', {
        p_user_id: user.id,
        p_current_epoch: currentEpoch,
        p_current_fingerprint: currentFingerprint,
        p_proposed_identity_key: proposedIdentityKey,
        p_proposed_signing_key: proposedSigningKey,
        p_proposed_fingerprint: proposedFingerprint,
        p_proposed_binding_signature: proposedBindingSignature,
        p_approver_device_id: approverDeviceId,
        p_reason: reason,
      });
      if (error) {
        return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_BEGIN_REJECTED' });
      }
      return respond(req, 200, data as JsonObject);
    }

    const rotationId = text(input, 'rotation_id', 64);
    if (!UUID_RE.test(rotationId)) {
      return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_ID_INVALID' });
    }

    if (action === 'status') {
      const { data, error } = await admin.rpc('get_identity_rotation_status_v1', {
        p_user_id: user.id,
        p_rotation_id: rotationId,
      });
      if (error) return respond(req, 404, { ok: false, code: 'IDENTITY_ROTATION_NOT_FOUND' });
      return respond(req, 200, data as JsonObject);
    }

    if (action === 'cancel') {
      const { data, error } = await admin.rpc('cancel_identity_rotation_v1', {
        p_user_id: user.id,
        p_rotation_id: rotationId,
      });
      if (error) return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_CANCEL_REJECTED' });
      return respond(req, 200, data as JsonObject);
    }

    const oldIdentitySignature = text(input, 'old_identity_signature', 256);
    const approverSignature = text(input, 'approver_signature', 256);
    const currentDeviceAuthorizationSignature = text(
      input,
      'current_device_authorization_signature',
      256,
    );
    if (!oldIdentitySignature || !approverSignature || !currentDeviceAuthorizationSignature) {
      return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_SIGNATURES_REQUIRED' });
    }

    const { data: requestData, error: requestError } = await admin
      .from('identity_rotation_requests')
      .select('id,user_id,current_epoch,next_epoch,current_fingerprint,proposed_identity_key,proposed_signing_key,proposed_fingerprint,proposed_binding_signature,proposed_binding_version,approver_device_id,reason,challenge_payload,expires_at,committed_at,cancelled_at')
      .eq('id', rotationId)
      .eq('user_id', user.id)
      .maybeSingle();
    const rotation = requestData as RotationRow | null;
    if (requestError || !rotation) {
      return respond(req, 404, { ok: false, code: 'IDENTITY_ROTATION_NOT_FOUND' });
    }

    if (rotation.committed_at) {
      return respond(req, 200, {
        ok: true,
        code: 'IDENTITY_ROTATION_ALREADY_COMMITTED',
        rotation_id: rotation.id,
        identity_epoch: rotation.next_epoch,
        fingerprint: rotation.proposed_fingerprint,
        surviving_device_id: rotation.approver_device_id,
        other_devices_revoked: true,
      });
    }
    if (rotation.cancelled_at) {
      return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_CANCELLED' });
    }
    if (Date.parse(rotation.expires_at) <= Date.now()) {
      return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_EXPIRED' });
    }

    const [currentResult, deviceResult] = await Promise.all([
      admin
        .from('user_public_keys')
        .select('id,identity_key,signing_key,fingerprint,identity_binding_signature,identity_binding_version,identity_epoch,is_active')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from('user_devices')
        .select('device_id,device_public_key,device_signing_key,approval_status,is_active,revoked_at,crypto_invalid_at')
        .eq('user_id', user.id)
        .eq('device_id', rotation.approver_device_id)
        .maybeSingle(),
    ]);
    const current = currentResult.data as AccountIdentityRow | null;
    const device = deviceResult.data as DeviceRow | null;

    if (
      currentResult.error || !current ||
      current.identity_epoch !== rotation.current_epoch ||
      current.fingerprint !== rotation.current_fingerprint
    ) {
      return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_CURRENT_IDENTITY_CHANGED' });
    }
    if (deviceResult.error || !trustedDevice(device)) {
      return respond(req, 403, { ok: false, code: 'IDENTITY_ROTATION_APPROVER_NOT_TRUSTED' });
    }

    const [oldProofValid, deviceProofValid, proposedBindingValid, deviceAuthorizationValid] = await Promise.all([
      verifyEd25519(current.signing_key, oldIdentitySignature, rotation.challenge_payload),
      verifyEd25519(device.device_signing_key, approverSignature, rotation.challenge_payload),
      validateProposedBinding({
        identityKey: rotation.proposed_identity_key,
        signingKey: rotation.proposed_signing_key,
        fingerprint: rotation.proposed_fingerprint,
        bindingSignature: rotation.proposed_binding_signature,
      }),
      verifyEd25519(
        rotation.proposed_signing_key,
        currentDeviceAuthorizationSignature,
        deviceAuthorizationPayload({
          userId: user.id,
          deviceId: device.device_id,
          accountFingerprint: rotation.proposed_fingerprint,
          devicePublicKey: device.device_public_key,
          deviceSigningKey: device.device_signing_key,
        }),
      ),
    ]);

    if (!oldProofValid) {
      return respond(req, 422, { ok: false, code: 'IDENTITY_ROTATION_OLD_IDENTITY_PROOF_INVALID' });
    }
    if (!deviceProofValid) {
      return respond(req, 422, { ok: false, code: 'IDENTITY_ROTATION_DEVICE_PROOF_INVALID' });
    }
    if (!proposedBindingValid) {
      return respond(req, 422, { ok: false, code: 'IDENTITY_ROTATION_NEW_BINDING_INVALID' });
    }
    if (!deviceAuthorizationValid) {
      return respond(req, 422, { ok: false, code: 'IDENTITY_ROTATION_DEVICE_AUTHORIZATION_INVALID' });
    }

    const { data, error } = await admin.rpc('commit_identity_rotation_v1', {
      p_user_id: user.id,
      p_rotation_id: rotation.id,
      p_approver_device_id: rotation.approver_device_id,
      p_old_identity_signature: oldIdentitySignature,
      p_approver_signature: approverSignature,
      p_current_device_authorization_signature: currentDeviceAuthorizationSignature,
    });
    if (error) {
      return respond(req, 409, { ok: false, code: 'IDENTITY_ROTATION_COMMIT_REJECTED' });
    }
    return respond(req, 200, data as JsonObject);
  } catch {
    return respond(req, 400, { ok: false, code: 'IDENTITY_ROTATION_REQUEST_INVALID' });
  }
});
