import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";

function getClientIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limit per IP + per user — protects against token-spamming abuse
    const ip = getClientIP(req);
    const ipLimit = await checkRateLimitDB(`device-link:ip:${ip}`, 30, 300, corsHeaders);
    if (ipLimit) return ipLimit;
    const userLimit = await checkRateLimitDB(`device-link:user:${user.id}`, 20, 300, corsHeaders);
    if (userLimit) return userLimit;

    const { action, ...params } = await req.json();

    // === CREATE: Generate a link token (source device) ===
    if (action === "create") {
      // Clean up old tokens first
      await supabase
        .from("device_link_tokens")
        .delete()
        .eq("user_id", user.id);

      // Generate a random token and hash it for storage
      const tokenBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenBytes);
      const token = btoa(String.fromCharCode(...tokenBytes));

      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
      );
      const tokenHash = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));

      const { error: insertError } = await supabase
        .from("device_link_tokens")
        .insert({
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

      if (insertError) throw insertError;

      return new Response(
        JSON.stringify({ token, expires_in: 300 }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // === UPLOAD: Source device uploads encrypted keys ===
    if (action === "upload") {
      const { encrypted_payload } = params;
      if (!encrypted_payload || typeof encrypted_payload !== "string") {
        return new Response(
          JSON.stringify({ error: "Missing encrypted_payload" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Max 500KB
      if (encrypted_payload.length > 512_000) {
        return new Response(
          JSON.stringify({ error: "Payload too large" }),
          {
            status: 413,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const { error: updateError } = await supabase
        .from("device_link_tokens")
        .update({ encrypted_payload })
        .eq("user_id", user.id)
        .is("claimed_at", null);

      if (updateError) throw updateError;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // === CLAIM: New device claims the keys using the token (atomic single-use) ===
    if (action === "claim") {
      const { token } = params;
      if (!token || typeof token !== "string" || token.length > 1024) {
        return new Response(
          JSON.stringify({ error: "Missing token" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
      );
      const tokenHash = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));

      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      // Atomic single-use consumption: marks claimed_at = now() iff still unclaimed
      // and unexpired, in a single SQL statement (no TOCTOU window).
      const { data: claimed, error: claimErr } = await serviceClient.rpc(
        "consume_device_link_token",
        { p_token_hash: tokenHash }
      );

      if (claimErr) {
        console.error("[device-link] claim rpc failed", claimErr.message);
        return new Response(
          JSON.stringify({ error: "Internal error" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const row = Array.isArray(claimed) ? claimed[0] : claimed;
      if (!row) {
        // Either invalid, expired, or already claimed
        return new Response(
          JSON.stringify({ error: "Invalid, expired or already-claimed token" }),
          { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (row.user_id !== user.id) {
        // Token consumed but belongs to another user — refuse and audit
        await serviceClient.from("audit_logs").insert({
          user_id: user.id,
          target_user_id: row.user_id,
          event_type: "device_link_owner_mismatch",
          metadata: { ip },
        });
        return new Response(
          JSON.stringify({ error: "Token belongs to a different account" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!row.encrypted_payload) {
        return new Response(
          JSON.stringify({ error: "Keys not yet uploaded by source device" }),
          { status: 425, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Audit successful claim
      await serviceClient.from("audit_logs").insert({
        user_id: user.id,
        event_type: "device_link_claimed",
        metadata: { ip },
      }).then(() => {}, () => {});

      return new Response(
        JSON.stringify({ encrypted_payload: row.encrypted_payload }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[device-link]", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
