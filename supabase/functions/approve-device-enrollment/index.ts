import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;

type DeviceRow = {
  device_id: string;
  device_public_key: string | null;
  device_signing_key: string | null;
  device_authorization_signature: string | null;
  approval_challenge_id: string | null;
  approval_status: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
};

type AccountRow = {
  identity_key: string;
  signing_key: string;
  fingerprint: string;
  identity_binding_signature: string;
  identity_binding_version: number;
};

type ChallengeRow = {
  id: string;
  device_id: string;
  nonce_hash: string;
  expires_at: string;
  consumed_at: string | null;
  cancelled_at: string | null;
  device_possession_signature: string | null;
  possession_payload_version: number | null;
};

function respond(req: Request, status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function decodeBase64(value: string, expectedLength: number, label: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error(`${label}_BASE64_INVALID`);
  }
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error(`${label}_BASE64_INVALID`);
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length !== expectedLength) throw new Error(`${label}_LENGTH_INVALID`);
  return bytes;
}

function normalizeExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("DEVICE_ENROLLMENT_INVALID_EXPIRY");
  return new Date(timestamp).toISOString();
}

function accountBindingPayload(account: AccountRow): string {
  return JSON.stringify({
    protocol: "forsure-aegis-account-identity",
    version: 1,
    identityKey: account.identity_key,
    signingKey: account.signing_key,
  });
}

function deviceAuthorizationPayload(userId: string, device: DeviceRow, account: AccountRow): string {
  return JSON.stringify({
    protocol: "forsure-aegis-device-authorization",
    userId,
    deviceId: device.device_id,
    accountFingerprint: account.fingerprint,
    devicePublicKey: device.device_public_key,
    deviceSigningKey: device.device_signing_key,
  });
}

function devicePossessionPayload(
  challenge: ChallengeRow,
  device: DeviceRow,
  account: AccountRow,
): string {
  return JSON.stringify({
    protocol: "forsure-aegis-device-possession",
    version: 1,
    challengeId: challenge.id,
    deviceId: device.device_id,
    nonceHash: challenge.nonce_hash.toLowerCase(),
    expiresAt: normalizeExpiry(challenge.expires_at),
    accountFingerprint: account.fingerprint,
    devicePublicKey: device.device_public_key,
    deviceSigningKey: device.device_signing_key,
  });
}

async function fingerprintForAccountPayload(payload: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(payload)));
  let fingerprint = "";
  for (let index = 0; index < 20; index += 1) {
    if (index > 0 && index % 4 === 0) fingerprint += " ";
    fingerprint += digest[index].toString(16).padStart(2, "0");
  }
  return fingerprint.toUpperCase();
}

async function verifyEd25519(publicKeyB64: string, signatureB64: string, payload: string): Promise<boolean> {
  try {
    const publicKey = decodeBase64(publicKeyB64, 32, "ED25519_PUBLIC_KEY");
    const signature = decodeBase64(signatureB64, 64, "ED25519_SIGNATURE");
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, signature, encoder.encode(payload));
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(req) });
  }
  if (req.method !== "POST") {
    return respond(req, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anonKey || !serviceRoleKey) {
    return respond(req, 500, { ok: false, code: "SERVER_CONFIGURATION_MISSING" });
  }

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return respond(req, 401, { ok: false, code: "NOT_AUTHENTICATED" });
  }

  const token = authorization.slice("Bearer ".length).trim();
  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    const user = userData.user;
    if (userError || !user) {
      return respond(req, 401, { ok: false, code: "NOT_AUTHENTICATED" });
    }

    let input: JsonObject;
    try {
      input = await req.json() as JsonObject;
    } catch {
      return respond(req, 400, { ok: false, code: "INVALID_JSON" });
    }

    const deviceId = typeof input.device_id === "string" ? input.device_id.trim() : "";
    if (!DEVICE_ID_RE.test(deviceId)) {
      return respond(req, 400, { ok: false, code: "INVALID_DEVICE_ID" });
    }

    const [deviceResult, accountResult] = await Promise.all([
      admin
        .from("user_devices")
        .select("device_id,device_public_key,device_signing_key,device_authorization_signature,approval_challenge_id,approval_status,is_active,revoked_at")
        .eq("user_id", user.id)
        .eq("device_id", deviceId)
        .maybeSingle(),
      admin
        .from("user_public_keys")
        .select("identity_key,signing_key,fingerprint,identity_binding_signature,identity_binding_version")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (deviceResult.error || !deviceResult.data) {
      return respond(req, 404, { ok: false, code: "DEVICE_NOT_FOUND" });
    }
    if (accountResult.error || !accountResult.data) {
      return respond(req, 409, { ok: false, code: "ACCOUNT_IDENTITY_NOT_FOUND" });
    }

    const device = deviceResult.data as DeviceRow;
    const account = accountResult.data as AccountRow;

    if (device.revoked_at || device.approval_status === "rejected") {
      return respond(req, 409, { ok: false, code: "DEVICE_REVOKED_OR_REJECTED" });
    }
    if (!device.device_public_key || !device.device_signing_key || !device.device_authorization_signature) {
      return respond(req, 422, { ok: false, code: "DEVICE_AUTHORIZATION_INCOMPLETE" });
    }
    if (!device.approval_challenge_id || !UUID_RE.test(device.approval_challenge_id)) {
      return respond(req, 409, { ok: false, code: "DEVICE_APPROVAL_CHALLENGE_NOT_FOUND" });
    }
    if (
      !account.identity_key ||
      !account.signing_key ||
      !account.fingerprint ||
      !account.identity_binding_signature ||
      account.identity_binding_version !== 1
    ) {
      return respond(req, 422, { ok: false, code: "ACCOUNT_BINDING_INCOMPLETE" });
    }

    const { data: challengeData, error: challengeError } = await admin
      .from("device_enrollment_challenges")
      .select("id,device_id,nonce_hash,expires_at,consumed_at,cancelled_at,device_possession_signature,possession_payload_version")
      .eq("id", device.approval_challenge_id)
      .eq("user_id", user.id)
      .eq("device_id", device.device_id)
      .maybeSingle();

    if (challengeError || !challengeData) {
      return respond(req, 409, { ok: false, code: "DEVICE_APPROVAL_CHALLENGE_NOT_FOUND" });
    }

    const challenge = challengeData as ChallengeRow;
    if (challenge.cancelled_at) {
      return respond(req, 409, { ok: false, code: "DEVICE_ENROLLMENT_CANCELLED" });
    }
    if (!challenge.consumed_at) {
      return respond(req, 409, { ok: false, code: "DEVICE_ENROLLMENT_NOT_COMPLETED" });
    }

    const consumedAt = Date.parse(challenge.consumed_at);
    const expiresAt = Date.parse(challenge.expires_at);
    if (
      !Number.isFinite(consumedAt) ||
      !Number.isFinite(expiresAt) ||
      consumedAt > expiresAt ||
      expiresAt <= Date.now()
    ) {
      return respond(req, 409, { ok: false, code: "DEVICE_ENROLLMENT_EXPIRED" });
    }
    if (
      challenge.possession_payload_version !== 1 ||
      !challenge.device_possession_signature
    ) {
      return respond(req, 422, { ok: false, code: "DEVICE_POSSESSION_PROOF_REQUIRED" });
    }

    const bindingPayload = accountBindingPayload(account);
    const expectedFingerprint = await fingerprintForAccountPayload(bindingPayload);
    if (expectedFingerprint !== account.fingerprint) {
      return respond(req, 422, { ok: false, code: "ACCOUNT_FINGERPRINT_INVALID" });
    }

    const accountBindingValid = await verifyEd25519(
      account.signing_key,
      account.identity_binding_signature,
      bindingPayload,
    );
    if (!accountBindingValid) {
      return respond(req, 422, { ok: false, code: "ACCOUNT_BINDING_SIGNATURE_INVALID" });
    }

    const deviceAuthorizationValid = await verifyEd25519(
      account.signing_key,
      device.device_authorization_signature,
      deviceAuthorizationPayload(user.id, device, account),
    );
    if (!deviceAuthorizationValid) {
      return respond(req, 422, { ok: false, code: "DEVICE_AUTHORIZATION_SIGNATURE_INVALID" });
    }

    const devicePossessionValid = await verifyEd25519(
      device.device_signing_key,
      challenge.device_possession_signature,
      devicePossessionPayload(challenge, device, account),
    );
    if (!devicePossessionValid) {
      return respond(req, 422, { ok: false, code: "DEVICE_POSSESSION_SIGNATURE_INVALID" });
    }

    const { data: finalizedData, error: finalizedError } = await admin.rpc(
      "finalize_verified_user_device_approval",
      {
        p_user_id: user.id,
        p_challenge_id: challenge.id,
        p_device_id: device.device_id,
        p_device_public_key: device.device_public_key,
        p_device_signing_key: device.device_signing_key,
        p_device_authorization_signature: device.device_authorization_signature,
        p_device_possession_signature: challenge.device_possession_signature,
        p_account_identity_key: account.identity_key,
        p_account_signing_key: account.signing_key,
        p_account_fingerprint: account.fingerprint,
        p_account_binding_signature: account.identity_binding_signature,
        p_account_binding_version: account.identity_binding_version,
      },
    );

    const finalized = finalizedData as JsonObject | null;
    if (finalizedError) {
      console.error("[approve-device-enrollment] finalizer failed", finalizedError.message);
      return respond(req, 500, { ok: false, code: "DEVICE_APPROVAL_FINALIZER_FAILED" });
    }
    if (!finalized || finalized.ok !== true || finalized.code !== "DEVICE_APPROVED") {
      const code = typeof finalized?.code === "string" ? finalized.code : "DEVICE_APPROVAL_REJECTED";
      return respond(req, 409, { ok: false, code });
    }

    return respond(req, 200, {
      ok: true,
      code: "DEVICE_APPROVED",
      device_id: device.device_id,
      challenge_id: challenge.id,
      existing: finalized.existing === true,
    });
  } catch (error) {
    console.error("[approve-device-enrollment] unexpected failure", error);
    return respond(req, 500, { ok: false, code: "DEVICE_APPROVAL_INTERNAL_ERROR" });
  }
});
