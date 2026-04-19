/**
 * Shared rate limiter for Edge Functions — DB-backed (persistent across instances).
 * Uses public.check_rate_limit() RPC for distributed, crash-safe rate limiting.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let rateLimitRpcUnavailable = false;

/**
 * Check and apply rate limit using persistent DB storage.
 * @returns null if allowed, or a Response(429) if rate-limited.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  headers: Record<string, string>,
): Promise<Response | null> {
  if (rateLimitRpcUnavailable) {
    return null;
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: allowed, error } = await supabase.rpc("check_rate_limit", {
      p_key: key,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      const missingRpc = error.message.includes("Could not find the function public.check_rate_limit");
      if (missingRpc) {
        rateLimitRpcUnavailable = true;
        console.warn("[rate-limit] check_rate_limit RPC unavailable — skipping DB-backed rate limiting");
        return null;
      }

      console.error("[rate-limit] DB check failed, allowing request:", error.message);
      return null; // Fail open on DB errors to avoid blocking legitimate users
    }

    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Too many requests", retry_after: windowSeconds }),
        {
          status: 429,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Retry-After": String(windowSeconds),
          },
        },
      );
    }

    return null;
  } catch (err) {
    console.error("[rate-limit] Unexpected error, allowing request:", err);
    return null; // Fail open
  }
}

/**
 * Extract client IP from request headers (works with Cloudflare / Supabase).
 */
export function getClientIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}
