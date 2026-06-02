// Shared authentication / authorization helpers for edge functions.
// Three guards:
//   - requireCronSecret(req): only callers with Authorization: Bearer <CRON_SECRET>
//   - requireAuthenticated(req): valid Supabase JWT, returns user
//   - requireAdmin(req): authenticated AND has 'admin' role in user_roles
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthDeniedResponse {
  ok: false;
  response: Response;
}
export interface AuthAllowedUser {
  ok: true;
  userId: string;
  token: string;
}

function deny(corsHeaders: Record<string, string>, status: number, code: string): AuthDeniedResponse {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: code }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
  };
}

/**
 * Cron / internal secret check. Reject anything that doesn't present
 * Authorization: Bearer <CRON_SECRET>. Also accepts the same token in
 * the `x-cron-secret` header for pg_cron flexibility.
 */
export function requireCronSecret(
  req: Request,
  corsHeaders: Record<string, string>,
): { ok: true } | AuthDeniedResponse {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected) return deny(corsHeaders, 500, "CRON_SECRET_NOT_CONFIGURED");
  const auth = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const presented = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : headerSecret.trim();
  if (!presented || presented !== expected) {
    return deny(corsHeaders, 401, "UNAUTHORIZED");
  }
  return { ok: true };
}

/**
 * Validate Supabase JWT and return user id. Uses anon key client with the
 * caller's token for getClaims().
 */
export async function requireAuthenticated(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<AuthAllowedUser | AuthDeniedResponse> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return deny(corsHeaders, 401, "UNAUTHORIZED");
  }
  const token = auth.slice(7).trim();
  if (!token) return deny(corsHeaders, 401, "UNAUTHORIZED");

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return deny(corsHeaders, 401, "UNAUTHORIZED");
    return { ok: true, userId: data.user.id, token };
  } catch {
    return deny(corsHeaders, 401, "UNAUTHORIZED");
  }
}

/**
 * Validate JWT AND check has_role(uid, 'admin').
 */
export async function requireAdmin(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<AuthAllowedUser | AuthDeniedResponse> {
  const authResult = await requireAuthenticated(req, corsHeaders);
  if (!("userId" in authResult)) return authResult;

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await admin.rpc("has_role", {
      _user_id: authResult.userId,
      _role: "admin",
    });
    if (error || data !== true) return deny(corsHeaders, 403, "FORBIDDEN");
    return authResult;
  } catch {
    return deny(corsHeaders, 403, "FORBIDDEN");
  }
}
