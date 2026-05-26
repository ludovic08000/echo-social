import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";

/**
 * verify-chat-pin — Server-side PIN verification for messaging (v2 — Hardened)
 * 
 * Actions: setup, verify, request-reset, confirm-reset
 * 
 * SECURITY:
 * - PIN hash (PBKDF2-SHA256, 600k iterations) computed SERVER-SIDE
 * - Hash NEVER sent to client (RLS blocks pin_hash/salt reads)
 * - Rate limiting: PERSISTENT in DB (not in-memory Map)
 * - Constant-time comparison
 * - Reset via email OTP (6-digit code, 10min expiry)
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;
const PBKDF2_ITERATIONS = 600_000;
const RESET_CODE_EXPIRY_MS = 10 * 60_000;
const RELEASE_ATTESTATION_TTL_MS = 60_000;

interface RateLimitInfo {
  allowed: boolean;
  failedAttempts: number;
  attemptsRemaining: number;
  lockedUntil: string | null;
  retryAfterSeconds: number;
}

interface BackupReleaseAttestationPayload {
  version: "svr2";
  action: "release_backup_pin_blob";
  userId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  backupSecretHash: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hashPinPBKDF2(pin: string, salt: Uint8Array): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const baseKey = await crypto.subtle.importKey("raw", pinBytes, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    256,
  );
  return bytesToBase64(new Uint8Array(derived));
}

async function hashPinLegacy(pin: string, salt: Uint8Array): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const combined = new Uint8Array(pinBytes.length + salt.length);
  combined.set(pinBytes);
  combined.set(salt, pinBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return bytesToBase64(new Uint8Array(hash));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function generateResetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 1000000).padStart(6, "0");
}

function generateBackupWrapSecret(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function retryAfterSecondsUntil(lockedUntil: string | null): number {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000));
}

function uiBackoffForFailedAttempts(failedAttempts: number): number {
  if (failedAttempts <= 0) return 0;
  return Math.min(60, 2 ** Math.min(failedAttempts - 1, 5));
}

function rateLimitInfo(failedAttempts: number, lockedUntil: string | null): RateLimitInfo {
  const retryAfterSeconds = lockedUntil
    ? retryAfterSecondsUntil(lockedUntil)
    : uiBackoffForFailedAttempts(failedAttempts);
  return {
    allowed: !lockedUntil && failedAttempts < MAX_ATTEMPTS,
    failedAttempts,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - failedAttempts),
    lockedUntil,
    retryAfterSeconds,
  };
}

function rateLimitOk(): RateLimitInfo {
  return {
    allowed: true,
    failedAttempts: 0,
    attemptsRemaining: MAX_ATTEMPTS,
    lockedUntil: null,
    retryAfterSeconds: 0,
  };
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function canonicalReleasePayload(payload: BackupReleaseAttestationPayload): string {
  return JSON.stringify({
    version: payload.version,
    action: payload.action,
    userId: payload.userId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
    backupSecretHash: payload.backupSecretHash,
  });
}

async function signReleasePayload(
  backupWrapSecret: string,
  payload: BackupReleaseAttestationPayload,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(backupWrapSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalReleasePayload(payload)),
  );
  return bytesToBase64(new Uint8Array(signature));
}

async function buildBackupReleaseAttestation(
  userId: string,
  backupWrapSecret: string,
) {
  const issuedAtMs = Date.now();
  const payload: BackupReleaseAttestationPayload = {
    version: "svr2",
    action: "release_backup_pin_blob",
    userId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + RELEASE_ATTESTATION_TTL_MS).toISOString(),
    nonce: bytesToBase64(crypto.getRandomValues(new Uint8Array(16))),
    backupSecretHash: await sha256Base64(base64ToBytes(backupWrapSecret)),
  };
  return {
    ...payload,
    signature: await signReleasePayload(backupWrapSecret, payload),
  };
}

/** Check rate limit from DB — returns true if allowed */
async function checkRateLimitDB(
  supabase: any,
  userId: string,
): Promise<RateLimitInfo> {
  const { data } = await supabase
    .from("user_chat_pins")
    .select("failed_attempts, locked_until")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return rateLimitOk(); // No PIN record = no rate limit
  
  if (data.locked_until && new Date(data.locked_until) > new Date()) {
    return rateLimitInfo(data.failed_attempts || MAX_ATTEMPTS, data.locked_until);
  }

  // If lockout expired, reset counter
  if (data.locked_until && new Date(data.locked_until) <= new Date()) {
    await supabase.from("user_chat_pins").update({
      failed_attempts: 0,
      locked_until: null,
    }).eq("user_id", userId);
    return rateLimitOk();
  }

  return rateLimitInfo(data.failed_attempts || 0, null);
}

/** Record a failed attempt in DB */
async function recordFailedDB(supabase: any, userId: string): Promise<RateLimitInfo> {
  const { data } = await supabase
    .from("user_chat_pins")
    .select("failed_attempts")
    .eq("user_id", userId)
    .maybeSingle();

  const newCount = (data?.failed_attempts || 0) + 1;
  const lockedUntil = newCount >= MAX_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_MS).toISOString()
    : null;

  await supabase.from("user_chat_pins").update({
    failed_attempts: newCount,
    locked_until: lockedUntil,
  }).eq("user_id", userId);

  return rateLimitInfo(newCount, lockedUntil);
}

/** Clear failed attempts on success */
async function clearFailedDB(supabase: any, userId: string) {
  await supabase.from("user_chat_pins").update({
    failed_attempts: 0,
    locked_until: null,
  }).eq("user_id", userId);
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // DDoS protection — critical tier for PIN verification
  const ddosBlock = await ddosShield(req, corsHeaders, "critical", "verify-chat-pin");
  if (ddosBlock) return ddosBlock;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action, pin, code } = body;
    const supabase = createClient(supabaseUrl, serviceKey);

    // ─── REQUEST RESET (send OTP email) ───
    if (action === "request-reset") {
      const rateLimit = await checkRateLimitDB(supabase, user.id);
      if (!rateLimit.allowed) {
        return new Response(JSON.stringify({ ok: false, error: "Trop de demandes. Reessayez plus tard.", ...rateLimit }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: pinData } = await supabase
        .from("user_chat_pins")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!pinData) {
        return new Response(JSON.stringify({ ok: false, error: "Aucun PIN configuré" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const resetCode = generateResetCode();
      const codeSalt = crypto.getRandomValues(new Uint8Array(16));
      const codeHash = await hashPinPBKDF2(resetCode, codeSalt);
      const expiresAt = new Date(Date.now() + RESET_CODE_EXPIRY_MS).toISOString();

      await supabase.from("user_chat_pins").update({
        reset_code_hash: codeHash,
        reset_code_salt: bytesToBase64(codeSalt),
        reset_code_expires: expiresAt,
        updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);

      const { data: profile } = await supabase
        .from("profiles")
        .select("name")
        .eq("user_id", user.id)
        .maybeSingle();

      const { error: emailError } = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "pin-reset-code",
          recipientEmail: user.email,
          idempotencyKey: `pin-reset-${user.id}-${Date.now()}`,
          templateData: {
            code: resetCode,
            name: profile?.name || undefined,
          },
        },
      });

      if (emailError) {
        console.error("[chat-pin] Failed to send reset email:", emailError);
        return new Response(JSON.stringify({ ok: false, error: "Erreur envoi email" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[chat-pin] reset code sent to user=${user.id}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── CONFIRM RESET (verify OTP and clear PIN) ───
    if (action === "confirm-reset") {
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
        return new Response(JSON.stringify({ ok: false, error: "Code invalide (6 chiffres)" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rateLimit = await checkRateLimitDB(supabase, user.id);
      if (!rateLimit.allowed) {
        return new Response(JSON.stringify({ ok: false, error: "Trop de tentatives.", ...rateLimit }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supabase
        .from("user_chat_pins")
        .select("reset_code_hash, reset_code_salt, reset_code_expires")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error || !data?.reset_code_hash || !data?.reset_code_salt) {
        return new Response(JSON.stringify({ ok: false, error: "Aucun code de réinitialisation en cours" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (new Date(data.reset_code_expires) < new Date()) {
        return new Response(JSON.stringify({ ok: false, error: "Code expiré. Demandez un nouveau code." }), {
          status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const salt = base64ToBytes(data.reset_code_salt);
      const computedHash = await hashPinPBKDF2(code, salt);
      if (!constantTimeEqual(computedHash, data.reset_code_hash)) {
        const failed = await recordFailedDB(supabase, user.id);
        return new Response(JSON.stringify({ ok: false, error: "Code incorrect", ...failed }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("user_chat_pins").delete().eq("user_id", user.id);
      console.log(`[chat-pin] PIN reset confirmed user=${user.id}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Validate PIN format for setup/verify ───
    if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
      return new Response(JSON.stringify({ error: "PIN invalide (6 chiffres)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    switch (action) {
      case "setup": {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const saltB64 = bytesToBase64(salt);
        const pinHash = await hashPinPBKDF2(pin, salt);
        const backupWrapSecret = generateBackupWrapSecret();

        const { error } = await supabase.from("user_chat_pins").upsert({
          user_id: user.id,
          pin_hash: pinHash,
          salt: saltB64,
          backup_wrap_secret: backupWrapSecret,
          failed_attempts: 0,
          locked_until: null,
          reset_code_hash: null,
          reset_code_salt: null,
          reset_code_expires: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

        if (error) throw error;

        console.log(`[chat-pin] setup ok user=${user.id}`);
        const releaseAttestation = await buildBackupReleaseAttestation(user.id, backupWrapSecret);
        return new Response(JSON.stringify({
          ok: true,
          salt: saltB64,
          backupSecret: backupWrapSecret,
          releaseAttestation,
          ...rateLimitOk(),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "verify": {
        const rateLimit = await checkRateLimitDB(supabase, user.id);
        if (!rateLimit.allowed) {
          return new Response(JSON.stringify({ ok: false, error: "Trop de tentatives. Reessayez plus tard.", ...rateLimit }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data, error } = await supabase
          .from("user_chat_pins")
          .select("pin_hash, salt, backup_wrap_secret")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          return new Response(JSON.stringify({ ok: false, error: "Aucun PIN configuré" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const salt = base64ToBytes(data.salt);
        const computedHash = await hashPinPBKDF2(pin, salt);
        let matched = constantTimeEqual(computedHash, data.pin_hash);

        if (!matched) {
          const legacyHash = await hashPinLegacy(pin, salt);
          if (constantTimeEqual(legacyHash, data.pin_hash)) {
            matched = true;
            await supabase.from("user_chat_pins").update({
              pin_hash: computedHash,
              updated_at: new Date().toISOString(),
            }).eq("user_id", user.id);
            console.log(`[chat-pin] migrated to PBKDF2 user=${user.id}`);
          }
        }

        if (matched) {
          let backupWrapSecret = data.backup_wrap_secret;
          if (!backupWrapSecret) {
            backupWrapSecret = generateBackupWrapSecret();
            await supabase.from("user_chat_pins").update({
              backup_wrap_secret: backupWrapSecret,
              updated_at: new Date().toISOString(),
            }).eq("user_id", user.id);
          }
          await clearFailedDB(supabase, user.id);
          console.log(`[chat-pin] verify ok user=${user.id}`);
          const releaseAttestation = await buildBackupReleaseAttestation(user.id, backupWrapSecret);
          return new Response(JSON.stringify({
            ok: true,
            salt: data.salt,
            backupSecret: backupWrapSecret,
            releaseAttestation,
            ...rateLimitOk(),
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          const failed = await recordFailedDB(supabase, user.id);
          console.warn(`[chat-pin] verify failed user=${user.id}`);
          return new Response(JSON.stringify({ ok: false, error: "PIN incorrect", ...failed }), {
            status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      default:
        return new Response(JSON.stringify({ error: `Action inconnue: ${action}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    console.error("[chat-pin] error:", e instanceof Error ? e.message : "unknown");
    const corsHeaders = getCorsHeaders(req);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
