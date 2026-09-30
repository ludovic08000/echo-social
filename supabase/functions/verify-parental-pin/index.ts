import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// In-memory rate limiting (per isolate; for production, use Redis or DB)
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000; // 5 minutes

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Auth ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

    const authedUserId = user.id;
    const { action, pin, current_pin, allowed_categories } = body;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── Server-side PIN hashing with per-user salt ──
    async function hashPinServer(rawPin: string, userId: string): Promise<string> {
      const encoder = new TextEncoder();
      const data = encoder.encode(rawPin + userId + "forsure-parental-v2");
      const hash = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    // New PINs require 8–12 digits. Verification keeps 4-digit legacy PINs
    // usable so existing families are not locked out during migration.
    if (pin !== undefined) {
      const format = action === "set" ? /^\d{8,12}$/ : /^\d{4,12}$/;
      if (typeof pin !== "string" || !format.test(pin)) {
        const requirement = action === "set" ? "8 à 12" : "4 à 12";
        return new Response(JSON.stringify({ error: `PIN invalide (${requirement} chiffres requis)` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    if (current_pin !== undefined && (typeof current_pin !== "string" || !/^\d{4,12}$/.test(current_pin))) {
      return new Response(JSON.stringify({ error: "PIN actuel invalide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Rate limiting on verify ──
    function checkRateLimit(userId: string): boolean {
      const now = Date.now();
      const entry = failedAttempts.get(userId);
      if (entry && now < entry.resetAt && entry.count >= MAX_ATTEMPTS) {
        return false; // locked out
      }
      if (entry && now >= entry.resetAt) {
        failedAttempts.delete(userId);
      }
      return true;
    }

    function recordFailedAttempt(userId: string) {
      const now = Date.now();
      const entry = failedAttempts.get(userId) || { count: 0, resetAt: now + LOCKOUT_MS };
      entry.count += 1;
      entry.resetAt = now + LOCKOUT_MS;
      failedAttempts.set(userId, entry);
    }

    function clearFailedAttempts(userId: string) {
      failedAttempts.delete(userId);
    }

    async function matchesStoredPin(rawPin: string, storedHash: string) {
      const currentHash = await hashPinServer(rawPin, user.id);
      if (currentHash === storedHash) return { ok: true, legacy: false, currentHash };

      const legacyData = new TextEncoder().encode(rawPin + "forsure-parental-salt");
      const legacyHashBuf = await crypto.subtle.digest("SHA-256", legacyData);
      const legacyHash = Array.from(new Uint8Array(legacyHashBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      return { ok: legacyHash === storedHash, legacy: legacyHash === storedHash, currentHash };
    }

    switch (action) {
      // ── SET PIN (create or update) ──
      case "set": {
        if (!pin) {
          return new Response(JSON.stringify({ error: "PIN requis" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Server-side age verification: compute age from profile DOB
        const { data: profile } = await supabase
          .from("profiles")
          .select("date_of_birth")
          .eq("user_id", user.id)
          .maybeSingle();

        if (profile?.date_of_birth) {
          const dob = new Date(profile.date_of_birth);
          const today = new Date();
          let serverAge = today.getFullYear() - dob.getFullYear();
          const m = today.getMonth() - dob.getMonth();
          if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) serverAge--;

          // Only allow parental controls for minors (< 16)
          if (serverAge >= 16) {
            console.warn(`[parental-pin] rejected: user=${user.id} age=${serverAge} >= 16`);
            return new Response(JSON.stringify({ error: "Le contrôle parental est réservé aux mineurs de moins de 16 ans." }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        const pinHash = await hashPinServer(pin, user.id);
        const allowedValues = new Set(["general", "education", "sport", "gaming", "musique", "art", "humour"]);
        const categories = Array.isArray(allowed_categories)
          ? [...new Set(allowed_categories.filter((value: unknown) => typeof value === "string" && allowedValues.has(value)))]
          : [];
        if (categories.length === 0) {
          return new Response(JSON.stringify({ error: "Sélectionnez au moins une catégorie autorisée" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: existing } = await supabase
          .from("parental_controls")
          .select("id,pin_hash")
          .eq("user_id", user.id)
          .maybeSingle();

        if (existing) {
          if (!current_pin || !checkRateLimit(user.id)) {
            return new Response(JSON.stringify({ error: "PIN actuel requis ou trop de tentatives" }), {
              status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          const verified = await matchesStoredPin(current_pin, existing.pin_hash);
          if (!verified.ok) {
            recordFailedAttempt(user.id);
            return new Response(JSON.stringify({ error: "PIN actuel incorrect" }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          clearFailedAttempts(user.id);
          const { error } = await supabase
            .from("parental_controls")
            .update({
              pin_hash: pinHash,
              allowed_categories: categories,
              is_active: true,
              is_minor: true,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", user.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from("parental_controls")
            .insert({
              user_id: user.id,
              pin_hash: pinHash,
              is_minor: true,
              allowed_categories: categories,
            });
          if (error) throw error;
        }

        console.log(`[parental-pin] set ok user=${user.id}`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "disable": {
        if (!pin || !checkRateLimit(user.id)) {
          return new Response(JSON.stringify({ ok: false, error: "PIN requis ou trop de tentatives" }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data, error } = await supabase
          .from("parental_controls")
          .select("pin_hash")
          .eq("user_id", user.id)
          .maybeSingle();
        if (error) throw error;
        const verified = data ? await matchesStoredPin(pin, data.pin_hash) : null;
        if (!verified?.ok) {
          recordFailedAttempt(user.id);
          return new Response(JSON.stringify({ ok: false, error: "PIN incorrect" }), {
            status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        await supabase
          .from("parental_controls")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("user_id", user.id);
        clearFailedAttempts(user.id);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ── VERIFY PIN ──
      case "verify": {
        if (!pin) {
          return new Response(JSON.stringify({ error: "PIN requis" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Rate limit check
        if (!checkRateLimit(user.id)) {
          console.warn(`[parental-pin] rate-limited user=${user.id}`);
          return new Response(JSON.stringify({ ok: false, error: "Trop de tentatives. Réessayez dans 5 minutes." }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data, error } = await supabase
          .from("parental_controls")
          .select("pin_hash")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          return new Response(JSON.stringify({ ok: false, error: "Aucun contrôle parental configuré" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const verified = await matchesStoredPin(pin, data.pin_hash);
        const success = verified.ok;

        if (verified.legacy) {
          await supabase
            .from("parental_controls")
            .update({ pin_hash: verified.currentHash, updated_at: new Date().toISOString() })
            .eq("user_id", user.id);
        }

        if (success) {
          clearFailedAttempts(user.id);
          console.log(`[parental-pin] verify ok user=${user.id}`);
        } else {
          recordFailedAttempt(user.id);
          console.warn(`[parental-pin] verify failed user=${user.id}`);
        }

        return new Response(JSON.stringify({ ok: success }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ error: `Action inconnue: ${action}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    console.error("[parental-pin] error:", e instanceof Error ? e.message : "unknown");
    const corsHeaders = getCorsHeaders(req);
    return new Response(
      JSON.stringify({ error: "Erreur serveur" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
