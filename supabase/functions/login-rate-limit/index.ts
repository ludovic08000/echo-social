// Server-side anti-bruteforce gate for login.
// - check: returns whether the IP/email pair may attempt to log in now
// - record: stores the outcome of an attempt (success/failure)
// Email is hashed (SHA-256) before storage; raw email never persisted.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIP(req: Request): string | null {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, email, success } = await req.json().catch(() => ({}));
    if (!action || (action !== "check" && action !== "record")) {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!email || typeof email !== "string" || email.length > 320) {
      return new Response(JSON.stringify({ error: "Invalid email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ip = getClientIP(req);
    const emailHash = await sha256Hex(email.toLowerCase().trim());
    const ua = req.headers.get("user-agent")?.slice(0, 500) ?? null;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (action === "check") {
      const { data, error } = await admin.rpc("check_login_rate_limit", {
        p_ip: ip,
        p_email_hash: emailHash,
      });
      if (error) {
        // Fail-open but log — never block legitimate users on infra failure
        console.error("[login-rate-limit] check failed", error.message);
        return new Response(
          JSON.stringify({ allowed: true, retry_after_seconds: 0, degraded: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(data ?? { allowed: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // record
    if (typeof success !== "boolean") {
      return new Response(JSON.stringify({ error: "Missing success flag" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.rpc("record_login_attempt", {
      p_ip: ip,
      p_email_hash: emailHash,
      p_success: success,
      p_user_agent: ua,
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[login-rate-limit]", err);
    return new Response(
      JSON.stringify({ allowed: true, degraded: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
