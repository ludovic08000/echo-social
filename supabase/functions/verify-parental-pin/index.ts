import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Compatibility endpoint for older cached clients. Parental controls are
// disabled globally; this endpoint authenticates the caller and never reads or
// mutates PINs, profiles, messaging routes or parental-control records.
const PARENTAL_CONTROLS_ENABLED = false;

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) {
      throw new Error("Configuration Supabase indisponible");
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      enabled: PARENTAL_CONTROLS_ENABLED,
      disabled: true,
    }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    console.error(
      "[parental-pin-disabled] error:",
      error instanceof Error ? error.message : "unknown",
    );
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
