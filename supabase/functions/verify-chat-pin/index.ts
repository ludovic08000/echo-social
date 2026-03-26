import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

/**
 * verify-chat-pin — Server-side PIN verification for messaging
 * 
 * SECURITY:
 * - PIN hash (PBKDF2-SHA256, 600k iterations) is computed SERVER-SIDE
 * - Hash is NEVER sent to the client
 * - Rate limiting: 5 attempts max, 5min lockout
 * - Constant-time comparison to prevent timing attacks
 */

const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;
const PBKDF2_ITERATIONS = 600_000;

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

/** PBKDF2-SHA256 600k iterations — brute-force resistant */
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

/** Legacy SHA-256 hash for migration */
async function hashPinLegacy(pin: string, salt: Uint8Array): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const combined = new Uint8Array(pinBytes.length + salt.length);
  combined.set(pinBytes);
  combined.set(salt, pinBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return bytesToBase64(new Uint8Array(hash));
}

/** Constant-time comparison */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(userId);
  if (entry && now < entry.resetAt && entry.count >= MAX_ATTEMPTS) return false;
  if (entry && now >= entry.resetAt) failedAttempts.delete(userId);
  return true;
}

function recordFailed(userId: string) {
  const now = Date.now();
  const entry = failedAttempts.get(userId) || { count: 0, resetAt: now + LOCKOUT_MS };
  entry.count += 1;
  entry.resetAt = now + LOCKOUT_MS;
  failedAttempts.set(userId, entry);
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    // Verify JWT
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
    const { action, pin } = body;

    if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
      return new Response(JSON.stringify({ error: "PIN invalide (6 chiffres)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    switch (action) {
      case "setup": {
        // Generate server-side salt + hash
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const saltB64 = bytesToBase64(salt);
        const pinHash = await hashPinPBKDF2(pin, salt);

        const { error } = await supabase.from("user_chat_pins").upsert({
          user_id: user.id,
          pin_hash: pinHash,
          salt: saltB64,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

        if (error) throw error;

        console.log(`[chat-pin] setup ok user=${user.id}`);
        return new Response(JSON.stringify({ ok: true, salt: saltB64 }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "verify": {
        if (!checkRateLimit(user.id)) {
          return new Response(JSON.stringify({ ok: false, error: "Trop de tentatives. Réessayez dans 5 minutes." }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Fetch hash from DB (NEVER sent to client)
        const { data, error } = await supabase
          .from("user_chat_pins")
          .select("pin_hash, salt")
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

        // Legacy migration: try SHA-256
        if (!matched) {
          const legacyHash = await hashPinLegacy(pin, salt);
          if (constantTimeEqual(legacyHash, data.pin_hash)) {
            matched = true;
            // Transparent migration to PBKDF2
            await supabase.from("user_chat_pins").update({
              pin_hash: computedHash,
              updated_at: new Date().toISOString(),
            }).eq("user_id", user.id);
            console.log(`[chat-pin] migrated to PBKDF2 user=${user.id}`);
          }
        }

        if (matched) {
          failedAttempts.delete(user.id);
          console.log(`[chat-pin] verify ok user=${user.id}`);
          // Return salt so client can derive local wrapping key
          return new Response(JSON.stringify({ ok: true, salt: data.salt }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          recordFailed(user.id);
          console.warn(`[chat-pin] verify failed user=${user.id}`);
          return new Response(JSON.stringify({ ok: false, error: "PIN incorrect" }), {
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