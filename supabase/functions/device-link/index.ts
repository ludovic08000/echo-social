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

    // === CLAIM: New device claims the keys using the token ===
    if (action === "claim") {
      const { token } = params;
      if (!token || typeof token !== "string") {
        return new Response(
          JSON.stringify({ error: "Missing token" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Hash the provided token
      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
      );
      const tokenHash = btoa(
        String.fromCharCode(...new Uint8Array(hashBuf))
      );

      // Use service role to read any user's token by hash
      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      const { data: linkData, error: fetchError } = await serviceClient
        .from("device_link_tokens")
        .select("id, user_id, encrypted_payload, expires_at, claimed_at")
        .eq("token_hash", tokenHash)
        .single();

      if (fetchError || !linkData) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired token" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Verify ownership
      if (linkData.user_id !== user.id) {
        return new Response(
          JSON.stringify({ error: "Token belongs to a different account" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Check expiry
      if (new Date(linkData.expires_at) < new Date()) {
        await serviceClient
          .from("device_link_tokens")
          .delete()
          .eq("id", linkData.id);
        return new Response(
          JSON.stringify({ error: "Token expired" }),
          {
            status: 410,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Check if already claimed
      if (linkData.claimed_at) {
        return new Response(
          JSON.stringify({ error: "Token already claimed" }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (!linkData.encrypted_payload) {
        return new Response(
          JSON.stringify({ error: "Keys not yet uploaded by source device" }),
          {
            status: 425,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Mark as claimed
      await serviceClient
        .from("device_link_tokens")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", linkData.id);

      return new Response(
        JSON.stringify({
          encrypted_payload: linkData.encrypted_payload,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
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
