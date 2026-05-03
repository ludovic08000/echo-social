import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function geoLookup(ip: string): Promise<{ country?: string; region?: string; city?: string }> {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
    return {};
  }
  try {
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { "User-Agent": "Forsure-Security/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return {};
    const j = await r.json();
    return { country: j.country_name || j.country, region: j.region, city: j.city };
  } catch {
    return {};
  }
}

function randomToken(len = 48): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    const ip = (req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
      req.headers.get("CF-Connecting-IP") || "unknown");
    const ua = req.headers.get("User-Agent") || "";

    if (action === "register") {
      const { rawFingerprint, deviceLabel } = body;
      if (!rawFingerprint || typeof rawFingerprint !== "string") {
        return new Response(JSON.stringify({ error: "invalid_fingerprint" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // SHA-256 device key — unique per (user, device signature)
      const deviceHash = await sha256Hex(`${user.id}|${rawFingerprint}`);
      const geo = await geoLookup(ip);

      const { data: existing } = await svc
        .from("device_keys")
        .select("id, status, country, city, verification_token")
        .eq("user_id", user.id)
        .eq("device_hash", deviceHash)
        .maybeSingle();

      if (existing) {
        // Known device — refresh last_seen and detect geo drift
        const geoChanged =
          (geo.country && existing.country && geo.country !== existing.country) ||
          (geo.city && existing.city && geo.city !== existing.city);

        await svc.from("device_keys").update({
          last_seen_at: new Date().toISOString(),
          ip_address: ip,
          country: geo.country ?? existing.country ?? null,
          region: geo.region ?? null,
          city: geo.city ?? existing.city ?? null,
        }).eq("id", existing.id);

        if (geoChanged) {
          await svc.from("login_alerts").insert({
            user_id: user.id, device_hash: deviceHash, ip_address: ip,
            country: geo.country ?? null, region: geo.region ?? null, city: geo.city ?? null,
            user_agent: ua,
          });
        }

        return new Response(JSON.stringify({
          status: existing.status,
          deviceHash,
          geoChanged,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // New device — needs email confirmation
      const token = randomToken();
      const { data: inserted } = await svc.from("device_keys").insert({
        user_id: user.id,
        device_hash: deviceHash,
        device_label: deviceLabel || null,
        user_agent: ua,
        ip_address: ip,
        country: geo.country ?? null,
        region: geo.region ?? null,
        city: geo.city ?? null,
        status: "pending",
        verification_token: token,
        verification_sent_at: new Date().toISOString(),
      }).select("id").single();

      const { data: alert } = await svc.from("login_alerts").insert({
        user_id: user.id, device_hash: deviceHash, ip_address: ip,
        country: geo.country ?? null, region: geo.region ?? null, city: geo.city ?? null,
        user_agent: ua,
      }).select("id").single();

      const location = [geo.city, geo.region, geo.country].filter(Boolean).join(", ") || "Lieu inconnu";

      try {
        await svc.functions.invoke("send-transactional-email", {
          body: {
            templateName: "new-device-login",
            recipientEmail: user.email,
            idempotencyKey: `device-login-${inserted?.id}`,
            templateData: {
              location,
              ip,
              userAgent: ua,
              approveUrl: `${Deno.env.get("APP_URL") || "https://forsure.fans"}/security/device?token=${token}&action=approve`,
              rejectUrl: `${Deno.env.get("APP_URL") || "https://forsure.fans"}/security/device?token=${token}&action=reject`,
              when: new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
            },
          },
        });
        await svc.from("login_alerts").update({ email_sent: true }).eq("id", alert!.id);
      } catch (e) {
        console.error("email send failed", e);
      }

      return new Response(JSON.stringify({ status: "pending", deviceHash, requiresVerification: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify") {
      const { token, decision } = body; // decision: 'approve' | 'reject'
      if (!token || !["approve", "reject"].includes(decision)) {
        return new Response(JSON.stringify({ error: "invalid" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { data: device } = await svc.from("device_keys")
        .select("id, user_id").eq("verification_token", token).maybeSingle();
      if (!device || device.user_id !== user.id) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const update: Record<string, unknown> = { verification_token: null };
      if (decision === "approve") {
        update.status = "trusted";
        update.trusted_at = new Date().toISOString();
      } else {
        update.status = "revoked";
        update.revoked_at = new Date().toISOString();
      }
      await svc.from("device_keys").update(update).eq("id", device.id);
      await svc.from("login_alerts").update({ resolved: decision, resolved_at: new Date().toISOString() })
        .eq("user_id", user.id).eq("device_hash", (await svc.from("device_keys").select("device_hash").eq("id", device.id).single()).data!.device_hash);

      return new Response(JSON.stringify({ ok: true, decision }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list") {
      const { data } = await svc.from("device_keys")
        .select("id, device_hash, device_label, country, city, status, last_seen_at, created_at")
        .eq("user_id", user.id).order("last_seen_at", { ascending: false });
      return new Response(JSON.stringify({ devices: data || [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "revoke") {
      const { deviceId } = body;
      await svc.from("device_keys").update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("id", deviceId).eq("user_id", user.id);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "invalid_action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("device-security error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
