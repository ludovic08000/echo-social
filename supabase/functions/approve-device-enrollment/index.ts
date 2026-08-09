import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
type Decision = "approve" | "reject";

type DeviceRow = {
  device_id: string;
  device_public_key: string | null;
  device_signing_key: string | null;
  device_authorization_signature: string | null;
  approval_challenge_id: string | null;
  approval_status: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
  binding_status: string | null;
  possession_verified_at: string | null;
};

type ChallengeRow = {
  id: string;
  device_id: string;
  nonce_hash: string;
  expires_at: string;
  consumed_at: string | null;
  cancelled_at: string | null;
  device_possession_signature: string | null;
};

type AccountRow = {
  identity_key: string;
  signing_key: string;
  fingerprint: string;
  identity_binding_signature: string;
  identity_binding_version: number;
};

function respond(req: Request, status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function decodeBase64(value: string, expectedLength: number): Uint8Array {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error("BASE64_INVALID");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  if (bytes.length !== expectedLength) throw new Error("BASE64_LENGTH_INVALID");
  return bytes;
}

async function verifyEd25519(publicKeyB64: string, signatureB64: string, payload: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", decodeBase64(publicKeyB64, 32), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, decodeBase64(signatureB64, 64), encoder.encode(payload));
  } catch {
    return false;
  }
}

function normalizeExpiry(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("DEVICE_ENROLLMENT_INVALID_EXPIRY");
  return new Date(ms).toISOString();
}

function approvalPayload(userId: string, device: DeviceRow, challengeId: string, decision: Decision): string {
  return JSON.stringify({
    protocol: "forsure-aegis-device-approval-decision",
    userId,
    deviceId: device.device_id,
    challengeId,
    devicePublicKey: device.device_public_key,
    deviceSigningKey: device.device_signing_key,
    decision,
  });
}

function possessionPayload(challenge: ChallengeRow, device: DeviceRow): string {
  return JSON.stringify({
    protocol: "forsure-aegis-device-possession",
    challengeId: challenge.id,
    deviceId: device.device_id,
    nonceHash: challenge.nonce_hash.toLowerCase(),
    expiresAt: normalizeExpiry(challenge.expires_at),
    devicePublicKey: device.device_public_key,
    deviceSigningKey: device.device_signing_key,
  });
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

async function fingerprintForAccountPayload(payload: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(payload)));
  let fingerprint = "";
  for (let i = 0; i < 20; i += 1) {
    if (i > 0 && i % 4 === 0) fingerprint += " ";
    fingerprint += digest[i].toString(16).padStart(2, "0");
  }
  return fingerprint.toUpperCase();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return respond(req, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anonKey || !serviceRoleKey) return respond(req, 500, { ok: false, code: "SERVER_CONFIGURATION_MISSING" });

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return respond(req, 401, { ok: false, code: "NOT_AUTHENTICATED" });

  const token = authorization.slice(7).trim();
  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const user = userData.user;
  if (userError || !user) return respond(req, 401, { ok: false, code: "NOT_AUTHENTICATED" });

  let input: JsonObject;
  try { input = await req.json() as JsonObject; } catch { return respond(req, 400, { ok: false, code: "INVALID_JSON" }); }

  const action = input.action === "bind" ? "bind" : "decision";
  const deviceId = typeof input.device_id === "string" ? input.device_id.trim() : "";
  if (!DEVICE_ID_RE.test(deviceId)) return respond(req, 400, { ok: false, code: "INVALID_DEVICE_ID" });

  const { data: deviceData, error: deviceError } = await admin
    .from("user_devices")
    .select("device_id,device_public_key,device_signing_key,device_authorization_signature,approval_challenge_id,approval_status,is_active,revoked_at,binding_status,possession_verified_at")
    .eq("user_id", user.id)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (deviceError || !deviceData) return respond(req, 404, { ok: false, code: "DEVICE_NOT_FOUND" });
  const device = deviceData as DeviceRow;

  if (action === "bind") {
    const signature = typeof input.device_authorization_signature === "string" ? input.device_authorization_signature.trim() : "";
    if (signature.length < 80) return respond(req, 400, { ok: false, code: "DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED" });
    if (device.approval_status !== "approved" || device.is_active !== true || device.revoked_at) return respond(req, 409, { ok: false, code: "DEVICE_NOT_APPROVED" });
    if (!device.possession_verified_at) return respond(req, 409, { ok: false, code: "DEVICE_POSSESSION_NOT_VERIFIED" });
    if (!device.device_public_key || !device.device_signing_key) return respond(req, 422, { ok: false, code: "DEVICE_KEYS_INCOMPLETE" });
    if (device.binding_status === "bound" && device.device_authorization_signature) {
      return respond(req, 200, { ok: true, code: "DEVICE_ACCOUNT_BOUND", device_id: device.device_id, existing: true });
    }

    const { data: accountData, error: accountError } = await admin
      .from("user_public_keys")
      .select("identity_key,signing_key,fingerprint,identity_binding_signature,identity_binding_version")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (accountError || !accountData) return respond(req, 409, { ok: false, code: "ACCOUNT_IDENTITY_NOT_FOUND" });
    const account = accountData as AccountRow;

    const bindingPayload = accountBindingPayload(account);
    if (await fingerprintForAccountPayload(bindingPayload) !== account.fingerprint) return respond(req, 422, { ok: false, code: "ACCOUNT_FINGERPRINT_INVALID" });
    const [accountValid, deviceValid] = await Promise.all([
      verifyEd25519(account.signing_key, account.identity_binding_signature, bindingPayload),
      verifyEd25519(account.signing_key, signature, deviceAuthorizationPayload(user.id, device, account)),
    ]);
    if (!accountValid) return respond(req, 422, { ok: false, code: "ACCOUNT_BINDING_SIGNATURE_INVALID" });
    if (!deviceValid) return respond(req, 422, { ok: false, code: "DEVICE_AUTHORIZATION_SIGNATURE_INVALID" });

    const { data: boundData, error: boundError } = await admin.rpc("finalize_device_account_binding", {
      p_user_id: user.id,
      p_device_id: device.device_id,
      p_device_authorization_signature: signature,
    });
    if (boundError) return respond(req, 500, { ok: false, code: "DEVICE_BINDING_FINALIZER_FAILED" });
    const bound = boundData as JsonObject | null;
    if (!bound || bound.ok !== true) return respond(req, 409, { ok: false, code: String(bound?.code ?? "DEVICE_BINDING_REJECTED") });
    return respond(req, 200, { ok: true, code: "DEVICE_ACCOUNT_BOUND", device_id: device.device_id });
  }

  const decision: Decision | null = input.decision === "approve" ? "approve" : input.decision === "reject" ? "reject" : null;
  const challengeId = typeof input.challenge_id === "string" ? input.challenge_id.trim() : "";
  const signature = typeof input.signature === "string" ? input.signature.trim() : "";
  if (!decision || !UUID_RE.test(challengeId) || signature.length < 80) return respond(req, 400, { ok: false, code: "INVALID_APPROVAL_REQUEST" });
  if (device.approval_status !== "pending" || device.is_active !== false || device.revoked_at) return respond(req, 409, { ok: false, code: "DEVICE_NOT_PENDING" });
  if (!device.device_public_key || !device.device_signing_key || device.approval_challenge_id !== challengeId) return respond(req, 422, { ok: false, code: "DEVICE_PENDING_PROOF_INCOMPLETE" });

  const { data: challengeData, error: challengeError } = await admin
    .from("device_enrollment_challenges")
    .select("id,device_id,nonce_hash,expires_at,consumed_at,cancelled_at,device_possession_signature")
    .eq("id", challengeId)
    .eq("user_id", user.id)
    .eq("device_id", device.device_id)
    .maybeSingle();
  if (challengeError || !challengeData) return respond(req, 409, { ok: false, code: "DEVICE_APPROVAL_CHALLENGE_NOT_FOUND" });
  const challenge = challengeData as ChallengeRow;

  const consumedAt = challenge.consumed_at ? Date.parse(challenge.consumed_at) : NaN;
  const expiresAt = Date.parse(challenge.expires_at);
  if (challenge.cancelled_at || !Number.isFinite(consumedAt) || !Number.isFinite(expiresAt) || consumedAt > expiresAt || consumedAt + 24 * 60 * 60 * 1000 <= Date.now()) {
    return respond(req, 409, { ok: false, code: "DEVICE_ENROLLMENT_EXPIRED" });
  }
  if (!challenge.device_possession_signature) return respond(req, 422, { ok: false, code: "DEVICE_POSSESSION_PROOF_REQUIRED" });

  const [approvalValid, possessionValid] = await Promise.all([
    verifyEd25519(device.device_signing_key, signature, approvalPayload(user.id, device, challengeId, decision)),
    verifyEd25519(device.device_signing_key, challenge.device_possession_signature, possessionPayload(challenge, device)),
  ]);
  if (!approvalValid) return respond(req, 422, { ok: false, code: "DEVICE_APPROVAL_SIGNATURE_INVALID" });
  if (!possessionValid) return respond(req, 422, { ok: false, code: "DEVICE_POSSESSION_SIGNATURE_INVALID" });

  if (decision === "reject") {
    const now = new Date().toISOString();
    const { data: rejected, error: rejectError } = await admin
      .from("user_devices")
      .update({
        approval_status: "rejected", is_active: false, rejected_at: now, rejected_by: user.id,
        revoked_at: now, revoke_reason: "user_rejected_pending_device", stale_at: now,
        binding_status: "revoked", routing_status: "unavailable", routing_error: "DEVICE_REJECTED", updated_at: now,
      })
      .eq("user_id", user.id).eq("device_id", device.device_id).eq("approval_status", "pending")
      .is("revoked_at", null).select("device_id");
    if (rejectError || !rejected || rejected.length !== 1) return respond(req, 409, { ok: false, code: "DEVICE_REJECTION_RACE_LOST" });
    return respond(req, 200, { ok: true, code: "DEVICE_REVOKED", device_id: device.device_id });
  }

  const { data: approvedData, error: approvedError } = await admin.rpc("finalize_self_approved_device", {
    p_user_id: user.id,
    p_challenge_id: challenge.id,
    p_device_id: device.device_id,
    p_device_public_key: device.device_public_key,
    p_device_signing_key: device.device_signing_key,
    p_device_possession_signature: challenge.device_possession_signature,
  });
  if (approvedError) return respond(req, 500, { ok: false, code: "DEVICE_APPROVAL_FINALIZER_FAILED" });
  const approved = approvedData as JsonObject | null;
  if (!approved || approved.ok !== true) return respond(req, 409, { ok: false, code: String(approved?.code ?? "DEVICE_APPROVAL_REJECTED") });

  return respond(req, 200, { ok: true, code: "DEVICE_APPROVED", device_id: device.device_id, challenge_id: challenge.id, binding_status: "pending" });
});
