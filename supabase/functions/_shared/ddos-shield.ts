/**
 * DDoS Shield middleware for Edge Functions.
 * 
 * Uses ddos_check_ip() RPC for progressive IP throttling.
 * Drop-in: call ddosShield(req, corsHeaders) at the top of any handler.
 * Returns null if allowed, or a 429 Response if blocked.
 * 
 * Tiers:
 *  - critical (auth, payment): 30 req/min
 *  - standard (API calls):     120 req/min
 *  - relaxed  (reads):         300 req/min
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type DDoSTier = "critical" | "standard" | "relaxed";

const TIER_CONFIG: Record<DDoSTier, { max: number; window: number }> = {
  critical: { max: 30, window: 60 },
  standard: { max: 120, window: 60 },
  relaxed:  { max: 300, window: 60 },
};

/** Extract the real client IP from proxy headers. */
function getIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Check if the request should be blocked.
 * @returns null → allowed, Response → blocked (429).
 */
export async function ddosShield(
  req: Request,
  corsHeaders: Record<string, string>,
  tier: DDoSTier = "standard",
  endpoint?: string,
): Promise<Response | null> {
  const ip = getIP(req);
  if (ip === "unknown") return null; // can't throttle without IP

  const config = TIER_CONFIG[tier];
  const ep = endpoint || new URL(req.url).pathname.split("/").pop() || "global";

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Check banned_ips first (fast path)
    const { data: banned } = await supabase
      .from("banned_ips")
      .select("id")
      .eq("ip_address", ip)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (banned) {
      return new Response(
        JSON.stringify({ error: "Access denied", code: "IP_BANNED" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Progressive throttle check
    const { data, error } = await supabase.rpc("ddos_check_ip", {
      p_ip: ip,
      p_endpoint: ep,
      p_max_requests: config.max,
      p_window_seconds: config.window,
    });

    if (error) {
      console.error("[ddos-shield] RPC error, allowing:", error.message);
      return null; // fail open
    }

    if (data && !data.allowed) {
      const retryAfter = data.retry_after_seconds || config.window;

      // Log the block event
      console.warn(
        `[ddos-shield] BLOCKED ip=${ip} endpoint=${ep} penalty=${data.penalty_level} retry=${retryAfter}s`,
      );

      return new Response(
        JSON.stringify({
          error: "Too many requests",
          code: "RATE_LIMITED",
          penalty_level: data.penalty_level,
          retry_after: retryAfter,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        },
      );
    }

    return null; // allowed
  } catch (err) {
    console.error("[ddos-shield] Error, allowing:", err);
    return null; // fail open on unexpected errors
  }
}
