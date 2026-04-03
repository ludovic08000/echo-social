/**
 * DDoS Shield — standalone Edge Function for manual checks + admin controls.
 * 
 * POST { action: "check" }          → check current IP status
 * POST { action: "status", ip }     → admin: get IP status (requires service role)
 * POST { action: "unblock", ip }    → admin: unblock an IP
 * POST { action: "cleanup" }        → admin: trigger cleanup of stale entries
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Self-protect this endpoint
  const blocked = await ddosShield(req, corsHeaders, "critical", "ddos-shield");
  if (blocked) return blocked;

  try {
    const body = await req.json();
    const { action } = body;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Public: check own IP ──
    if (action === "check") {
      const ip =
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        "unknown";

      const { data } = await supabase.rpc("ddos_check_ip", {
        p_ip: ip,
        p_endpoint: "global",
        p_max_requests: 120,
        p_window_seconds: 60,
      });

      return new Response(
        JSON.stringify({ ip: ip.substring(0, 8) + "***", status: data }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Admin actions: require auth ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    // Check admin role
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });

    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Admin: get IP status ──
    if (action === "status") {
      const { ip } = body;
      if (!ip) {
        return new Response(JSON.stringify({ error: "ip required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: tracker } = await supabase
        .from("ddos_ip_tracker")
        .select("*")
        .eq("ip_address", ip);

      const { data: bans } = await supabase
        .from("banned_ips")
        .select("*")
        .eq("ip_address", ip)
        .eq("is_active", true);

      return new Response(
        JSON.stringify({ tracker: tracker || [], bans: bans || [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Admin: unblock IP ──
    if (action === "unblock") {
      const { ip } = body;
      if (!ip) {
        return new Response(JSON.stringify({ error: "ip required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Remove from tracker
      await supabase
        .from("ddos_ip_tracker")
        .delete()
        .eq("ip_address", ip);

      // Deactivate bans
      await supabase
        .from("banned_ips")
        .update({ is_active: false })
        .eq("ip_address", ip);

      return new Response(
        JSON.stringify({ unblocked: true, ip }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Admin: cleanup stale entries ──
    if (action === "cleanup") {
      await supabase.rpc("ddos_cleanup");
      return new Response(
        JSON.stringify({ cleaned: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use: check, status, unblock, cleanup" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
