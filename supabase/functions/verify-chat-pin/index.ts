import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";

/**
 * Email recovery for the device-local messaging PIN.
 *
 * The PIN never reaches this function. The server keeps an opaque recovery
 * ticket and validates only a short-lived email reset code.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;
const PBKDF2_ITERATIONS = 600_000;
const RESET_CODE_EXPIRY_MS = 10 * 60_000;

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

async function hashRecoveryCode(code: string, salt: Uint8Array): Promise<string> {
  const codeBytes = new TextEncoder().encode(code);
  const baseKey = await crypto.subtle.importKey("raw", codeBytes, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    256,
  );
  return bytesToBase64(new Uint8Array(derived));
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

/** Check rate limit from DB — returns true if allowed */
async function checkRateLimitDB(
  supabase: any,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("user_chat_pins")
    .select("failed_attempts, locked_until")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return true; // No PIN record = no rate limit
  
  if (data.locked_until && new Date(data.locked_until) > new Date()) {
    return false; // Still locked
  }

  // If lockout expired, reset counter
  if (data.locked_until && new Date(data.locked_until) <= new Date()) {
    await supabase.from("user_chat_pins").update({
      failed_attempts: 0,
      locked_until: null,
    }).eq("user_id", userId);
  }

  return (data.failed_attempts || 0) < MAX_ATTEMPTS;
}

/** Record a failed attempt in DB */
async function recordFailedDB(supabase: any, userId: string) {
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
    const { action, code } = body;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Register only an opaque email-recovery ticket. These random values are
    // unrelated to the local PIN, so the server cannot verify or brute-force
    // the PIN used by the device.
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
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Legacy clients must not send PIN material to the server anymore.
    if (action === "setup" || action === "verify") {
      return new Response(JSON.stringify({ ok: false, error: "PIN_LOCAL_ONLY" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── REQUEST RESET (send OTP email) ───
    if (action === "request-reset") {
      if (!await checkRateLimitDB(supabase, user.id)) {
        return new Response(JSON.stringify({ ok: false, error: "Trop de demandes. Réessayez dans 5 minutes." }), {
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
      const codeHash = await hashRecoveryCode(resetCode, codeSalt);
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

      if (!await checkRateLimitDB(supabase, user.id)) {
        return new Response(JSON.stringify({ ok: false, error: "Trop de tentatives." }), {
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
      const computedHash = await hashRecoveryCode(code, salt);
      if (!constantTimeEqual(computedHash, data.reset_code_hash)) {
        await recordFailedDB(supabase, user.id);
        return new Response(JSON.stringify({ ok: false, error: "Code incorrect" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("user_chat_pins").delete().eq("user_id", user.id);
      console.log(`[chat-pin] PIN reset confirmed user=${user.id}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Action inconnue: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[chat-pin] error:", e instanceof Error ? e.message : "unknown");
    const corsHeaders = getCorsHeaders(req);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
