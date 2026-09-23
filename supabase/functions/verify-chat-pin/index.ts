import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";

/**
 * Email recovery for the device-local messaging PIN.
 *
 * The six-digit PIN never reaches Lovable Cloud. Email proves account access,
 * a fresh Ed25519 signature proves possession of a ready Aegis device, and the
 * browser supplies only a Master-Key-encrypted replacement envelope.
 */

const PBKDF2_ITERATIONS = 600_000;
const RESET_CODE_EXPIRY_MS = 10 * 60_000;
const RESET_AUTHORIZATION_EXPIRY_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

type JsonObject = Record<string, unknown>;

type RecoveryResult = {
  ok?: boolean;
  code?: string;
  challenge_id?: string;
  expires_at?: string;
  generation?: number;
  authorization_expires_at?: string;
  retry_after_seconds?: number;
  attempts_remaining?: number;
};

function jsonResponse(
  corsHeaders: Record<string, string>,
  status: number,
  body: JsonObject,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function recoveryLog(
  traceId: string,
  step: string,
  outcome: "start" | "success" | "failure",
  errorCode?: string,
): void {
  console.info(JSON.stringify({
    event: "aegis_chat_pin_recovery",
    traceId,
    step,
    outcome,
    ...(errorCode ? { errorCode } : {}),
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isCanonicalBase64(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): value is string {
  if (
    typeof value !== "string" ||
    !BASE64_RE.test(value) ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4
  ) {
    return false;
  }

  try {
    const bytes = base64ToBytes(value);
    if (bytes.length < minBytes || bytes.length > maxBytes) return false;
    return bytesToBase64(bytes).replace(/=+$/, "") === value.replace(/=+$/, "");
  } catch {
    return false;
  }
}

async function hashRecoveryCode(code: string, salt: Uint8Array): Promise<string> {
  const codeBytes = new TextEncoder().encode(code);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    codeBytes,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    256,
  );
  return bytesToBase64(new Uint8Array(derived));
}

async function hashAuthorizationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return bytesToBase64(new Uint8Array(digest));
}

function generateResetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const number = (
    (bytes[0] << 24) |
    (bytes[1] << 16) |
    (bytes[2] << 8) |
    bytes[3]
  ) >>> 0;
  return String(number % 1_000_000).padStart(6, "0");
}

function generateAuthorizationToken(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function asRecoveryResult(value: unknown): RecoveryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as RecoveryResult;
}

function rpcFailure(
  corsHeaders: Record<string, string>,
  result: RecoveryResult,
): Response {
  const code = result.code ?? "PIN_RESET_FAILED";
  const status = code === "SEND_COOLDOWN" ||
      code === "BURST_LIMIT_REACHED" ||
      code === "DAILY_LIMIT_REACHED" ||
      code === "RATE_LIMITED"
    ? 429
    : code === "CODE_MISMATCH" || code === "DEVICE_PROOF_INVALID"
    ? 403
    : code === "PIN_NOT_CONFIGURED" || code === "PIN_CONTINUITY_NOT_FOUND"
    ? 404
    : code === "PIN_GENERATION_CHANGED"
    ? 409
    : 400;

  const message = code === "SEND_COOLDOWN"
    ? "Un code vient déjà d’être envoyé. Patientez avant de recommencer."
    : code === "BURST_LIMIT_REACHED" || code === "DAILY_LIMIT_REACHED"
    ? "Trop de demandes de réinitialisation. Réessayez plus tard."
    : code === "RATE_LIMITED"
    ? "Trop de tentatives. Réessayez plus tard."
    : code === "CODE_MISMATCH"
    ? "Code incorrect."
    : code === "DEVICE_PROOF_INVALID"
    ? "Cet appareil Aegis n’est pas autorisé à réinitialiser le PIN."
    : code === "PIN_NOT_CONFIGURED" || code === "PIN_CONTINUITY_NOT_FOUND"
    ? "Aucun coffre PIN récupérable n’est configuré."
    : code === "PIN_GENERATION_CHANGED"
    ? "Le PIN a changé sur un autre appareil. Recommencez la procédure."
    : "La réinitialisation du PIN a été refusée.";

  return jsonResponse(corsHeaders, status, {
    ok: false,
    code,
    error: message,
    ...(typeof result.retry_after_seconds === "number"
      ? { retryAfterSeconds: result.retry_after_seconds }
      : {}),
    ...(typeof result.attempts_remaining === "number"
      ? { attemptsRemaining: result.attempts_remaining }
      : {}),
  });
}

function hasVerifiedEmail(user: { email?: string; email_confirmed_at?: string | null }): boolean {
  return Boolean(user.email && user.email_confirmed_at);
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const ddosBlock = await ddosShield(req, corsHeaders, "critical", "verify-chat-pin");
  if (ddosBlock) return ddosBlock;

  const traceId = crypto.randomUUID();
  recoveryLog(traceId, "request", "start");

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      recoveryLog(traceId, "authentication", "failure", "UNAUTHENTICATED");
      return jsonResponse(corsHeaders, 401, {
        ok: false,
        code: "UNAUTHENTICATED",
        error: "Non authentifié",
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceKey || !anonKey) {
      throw new Error("PIN_RECOVERY_SERVER_CONFIGURATION_MISSING");
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      recoveryLog(traceId, "authentication", "failure", "UNAUTHENTICATED");
      return jsonResponse(corsHeaders, 401, {
        ok: false,
        code: "UNAUTHENTICATED",
        error: "Non authentifié",
      });
    }

    const parsedBody = await req.json();
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return jsonResponse(corsHeaders, 400, {
        ok: false,
        code: "INVALID_REQUEST",
        error: "Requête invalide",
      });
    }
    const body = parsedBody as JsonObject;
    const action = typeof body.action === "string" ? body.action : "";
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Compatibility marker only. No PIN, verifier or Master Key is accepted.
    if (action === "register-local-recovery") {
      const opaqueHash = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      const opaqueSalt = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      const { error } = await supabase.from("user_chat_pins").upsert({
        user_id: user.id,
        pin_hash: opaqueHash,
        salt: opaqueSalt,
        failed_attempts: 0,
        locked_until: null,
        reset_code_hash: null,
        reset_code_salt: null,
        reset_code_expires: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw error;
      recoveryLog(traceId, "register_marker", "success");
      return jsonResponse(corsHeaders, 200, { ok: true });
    }

    if (action === "setup" || action === "verify") {
      return jsonResponse(corsHeaders, 410, {
        ok: false,
        code: "PIN_LOCAL_ONLY",
        error: "PIN_LOCAL_ONLY",
      });
    }

    if (
      action === "request-reset" ||
      action === "authorize-reset" ||
      action === "commit-reset" ||
      action === "confirm-reset"
    ) {
      if (!hasVerifiedEmail(user)) {
        recoveryLog(traceId, action, "failure", "EMAIL_NOT_VERIFIED");
        return jsonResponse(corsHeaders, 403, {
          ok: false,
          code: "EMAIL_NOT_VERIFIED",
          error: "Une adresse email vérifiée est requise.",
        });
      }
    }

    if (action === "request-reset") {
      const resetCode = generateResetCode();
      const codeSalt = crypto.getRandomValues(new Uint8Array(16));
      const codeHash = await hashRecoveryCode(resetCode, codeSalt);
      const expiresAt = new Date(Date.now() + RESET_CODE_EXPIRY_MS).toISOString();
      const { data, error } = await supabase.rpc("aegis_chat_pin_reset_begin", {
        p_user_id: user.id,
        p_code_hash: codeHash,
        p_code_salt: bytesToBase64(codeSalt),
        p_expires_at: expiresAt,
      });
      if (error) throw error;

      const result = asRecoveryResult(data);
      if (result.ok !== true || !result.challenge_id || !UUID_RE.test(result.challenge_id)) {
        recoveryLog(traceId, "request_reset", "failure", result.code);
        return rpcFailure(corsHeaders, result);
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("name")
        .eq("user_id", user.id)
        .maybeSingle();

      const { data: emailData, error: emailError } = await supabase.functions.invoke(
        "send-transactional-email",
        {
          body: {
            templateName: "pin-reset-code",
            recipientEmail: user.email,
            idempotencyKey: `pin-reset-${result.challenge_id}`,
            templateData: {
              code: resetCode,
              name: profile?.name || undefined,
            },
          },
        },
      );

      if (
        emailError ||
        !emailData ||
        typeof emailData !== "object" ||
        emailData.success !== true
      ) {
        await supabase
          .from("aegis_chat_pin_reset_challenges")
          .update({
            code_hash: null,
            code_salt: null,
            code_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id)
          .eq("challenge_id", result.challenge_id);
        recoveryLog(traceId, "send_email", "failure", "EMAIL_SEND_FAILED");
        return jsonResponse(corsHeaders, 503, {
          ok: false,
          code: "EMAIL_SEND_FAILED",
          error: "Le code n’a pas pu être envoyé. Réessayez plus tard.",
        });
      }

      recoveryLog(traceId, "request_reset", "success");
      return jsonResponse(corsHeaders, 200, {
        ok: true,
        challengeId: result.challenge_id,
        expiresAt: result.expires_at ?? expiresAt,
      });
    }

    if (action === "authorize-reset") {
      const code = body.code;
      const challengeId = body.challengeId;
      const deviceId = body.deviceId;
      const proofIssuedAtMs = body.deviceProofIssuedAtMs;
      const proofSignature = body.deviceProofSignature;
      if (
        typeof code !== "string" || !/^\d{6}$/.test(code) ||
        typeof challengeId !== "string" || !UUID_RE.test(challengeId) ||
        typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId) ||
        typeof proofIssuedAtMs !== "number" || !Number.isSafeInteger(proofIssuedAtMs) ||
        !isCanonicalBase64(proofSignature, 64, 128)
      ) {
        return jsonResponse(corsHeaders, 400, {
          ok: false,
          code: "INVALID_AUTHORIZATION",
          error: "Code ou preuve d’appareil invalide.",
        });
      }

      const { data: challenge, error: challengeError } = await supabase
        .from("aegis_chat_pin_reset_challenges")
        .select("code_salt")
        .eq("user_id", user.id)
        .eq("challenge_id", challengeId)
        .maybeSingle();
      if (challengeError) throw challengeError;
      if (!challenge?.code_salt || !isCanonicalBase64(challenge.code_salt, 16, 64)) {
        return jsonResponse(corsHeaders, 400, {
          ok: false,
          code: "CHALLENGE_NOT_ACTIVE",
          error: "Aucun code de réinitialisation actif.",
        });
      }

      const expectedCodeHash = await hashRecoveryCode(
        code,
        base64ToBytes(challenge.code_salt),
      );
      const authorizationToken = generateAuthorizationToken();
      const authorizationHash = await hashAuthorizationToken(authorizationToken);
      const authorizationExpiresAt = new Date(
        Date.now() + RESET_AUTHORIZATION_EXPIRY_MS,
      ).toISOString();
      const { data, error } = await supabase.rpc(
        "aegis_chat_pin_reset_authorize",
        {
          p_user_id: user.id,
          p_challenge_id: challengeId,
          p_expected_code_hash: expectedCodeHash,
          p_authorization_hash: authorizationHash,
          p_authorization_expires_at: authorizationExpiresAt,
          p_device_id: deviceId,
          p_device_proof_issued_at_ms: proofIssuedAtMs,
          p_device_proof_signature: proofSignature,
        },
      );
      if (error) throw error;

      const result = asRecoveryResult(data);
      if (result.ok !== true || !Number.isSafeInteger(result.generation)) {
        recoveryLog(traceId, "authorize_reset", "failure", result.code);
        return rpcFailure(corsHeaders, result);
      }

      recoveryLog(traceId, "authorize_reset", "success");
      return jsonResponse(corsHeaders, 200, {
        ok: true,
        challengeId,
        authorizationToken,
        authorizationExpiresAt:
          result.authorization_expires_at ?? authorizationExpiresAt,
        generation: result.generation,
      });
    }

    if (action === "commit-reset") {
      const challengeId = body.challengeId;
      const authorizationToken = body.authorizationToken;
      const deviceId = body.deviceId;
      const expectedGeneration = body.expectedGeneration;
      const version = body.version;
      const ciphertext = body.ciphertext;
      const iv = body.iv;
      if (
        typeof challengeId !== "string" || !UUID_RE.test(challengeId) ||
        !isCanonicalBase64(authorizationToken, 32, 32) ||
        typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId) ||
        typeof expectedGeneration !== "number" ||
        !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 ||
        version !== 1 ||
        !isCanonicalBase64(ciphertext, 48, 6_144) ||
        !isCanonicalBase64(iv, 12, 12)
      ) {
        return jsonResponse(corsHeaders, 400, {
          ok: false,
          code: "INVALID_COMMIT",
          error: "Données de remplacement du PIN invalides.",
        });
      }

      const authorizationHash = await hashAuthorizationToken(authorizationToken);
      const { data, error } = await supabase.rpc("aegis_chat_pin_reset_commit", {
        p_user_id: user.id,
        p_challenge_id: challengeId,
        p_authorization_hash: authorizationHash,
        p_device_id: deviceId,
        p_expected_generation: expectedGeneration,
        p_version: version,
        p_ciphertext: ciphertext,
        p_iv: iv,
      });
      if (error) throw error;

      const result = asRecoveryResult(data);
      if (result.ok !== true || !Number.isSafeInteger(result.generation)) {
        recoveryLog(traceId, "commit_reset", "failure", result.code);
        return rpcFailure(corsHeaders, result);
      }

      recoveryLog(traceId, "commit_reset", "success");
      return jsonResponse(corsHeaders, 200, {
        ok: true,
        generation: result.generation,
      });
    }

    // Cached clients may still call the old destructive action. Refuse it
    // safely: neither the local verifier nor the remote envelope is deleted.
    if (action === "confirm-reset") {
      recoveryLog(traceId, "legacy_confirm_reset", "failure", "SECURE_RESET_REQUIRED");
      return jsonResponse(corsHeaders, 409, {
        ok: false,
        code: "SECURE_RESET_REQUIRED",
        error: "Actualisez l’application pour utiliser la réinitialisation sécurisée.",
      });
    }

    return jsonResponse(corsHeaders, 400, {
      ok: false,
      code: "UNKNOWN_ACTION",
      error: `Action inconnue: ${action}`,
    });
  } catch (error) {
    recoveryLog(traceId, "request", "failure", "PIN_RECOVERY_INTERNAL_ERROR");
    console.error("[chat-pin] recovery failed", {
      traceId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(corsHeaders, 500, {
      ok: false,
      code: "PIN_RECOVERY_INTERNAL_ERROR",
      error: "Erreur serveur",
    });
  }
});
