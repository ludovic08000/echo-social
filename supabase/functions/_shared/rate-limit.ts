/**
 * Shared rate limiter for Edge Functions — DB-backed (persistent across instances).
 * Uses public.check_rate_limit() RPC for distributed, crash-safe rate limiting.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Check and apply rate limit using persistent DB storage.
 * @returns null only on explicit authorization; 429 on quota exhaustion, 503 on an unavailable authority.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  headers: Record<string, string>,
): Promise<Response | null> {
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
      console.error("[rate-limit] DB authority unavailable:", error.code ?? "RPC_ERROR");
      return unavailable(headers);
    }

    if (allowed === false) {
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

    // Une panne, une réponse vide ou un schéma incompatible n'est jamais une autorisation.
    return allowed === true ? null : unavailable(headers);
  } catch {
    console.error("[rate-limit] DB authority request failed");
    return unavailable(headers);
  }
}

function unavailable(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({
    error: "Vérification du quota temporairement indisponible", code: "RATE_LIMIT_UNAVAILABLE", retry_after: 5,
  }), { status: 503, headers: { ...headers, "Content-Type": "application/json", "Retry-After": "5", "Cache-Control": "no-store" } });
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
