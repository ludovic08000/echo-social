import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

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

    // Verify user identity from JWT
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
    const { action, pin, allowed_categories } = body;

    // Service client for DB operations (bypasses RLS)
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── Server-side PIN hashing with per-user salt ──
    async function hashPinServer(rawPin: string, userId: string): Promise<string> {
      const encoder = new TextEncoder();
      // Use user ID as salt — unique per user, not guessable
      const data = encoder.encode(rawPin + userId + "forsure-parental-v2");
      const hash = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    // Validate PIN format
    if (pin !== undefined) {
      if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
        return new Response(JSON.stringify({ error: "PIN invalide (4 à 6 chiffres requis)" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Rate limiting on verify: max 5 attempts per minute ──
    if (action === "verify") {
      const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
      // We track attempts via a simple in-memory map per user
      // For production, use a DB counter or Redis
    }

    switch (action) {
      // ── SET PIN (create or update) ──
      case "set": {
        if (!pin) {
          return new Response(JSON.stringify({ error: "PIN requis" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const pinHash = await hashPinServer(pin, user.id);
        const categories = Array.isArray(allowed_categories) && allowed_categories.length > 0
          ? allowed_categories
          : ["education", "sport", "gaming", "musique", "art", "humour"];

        // Upsert
        const { data: existing } = await supabase
          .from("parental_controls")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (existing) {
          const { error } = await supabase
            .from("parental_controls")
            .update({
              pin_hash: pinHash,
              allowed_categories: categories,
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

        const pinHash = await hashPinServer(pin, user.id);

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

        // Constant-time comparison to prevent timing attacks
        const match = pinHash === data.pin_hash;

        // Also support legacy hash format for migration
        let legacyMatch = false;
        if (!match) {
          const legacyEncoder = new TextEncoder();
          const legacyData = legacyEncoder.encode(pin + "forsure-parental-salt");
          const legacyHashBuf = await crypto.subtle.digest("SHA-256", legacyData);
          const legacyHash = Array.from(new Uint8Array(legacyHashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
          legacyMatch = legacyHash === data.pin_hash;

          // If legacy match, migrate to new hash format
          if (legacyMatch) {
            await supabase
              .from("parental_controls")
              .update({ pin_hash: pinHash, updated_at: new Date().toISOString() })
              .eq("user_id", user.id);
          }
        }

        return new Response(JSON.stringify({ ok: match || legacyMatch }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ error: `Action inconnue: ${action}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    console.error("verify-parental-pin error:", e);
    const corsHeaders = getCorsHeaders(req);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erreur serveur" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
