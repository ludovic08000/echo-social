import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";

type Role = "viewer" | "host" | "moderator";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
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

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Per-user rate limit (token issuance)
    const rateLimited = await checkRateLimitDB(`livekit:${userId}`, 10, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const { roomName } = await req.json().catch(() => ({}));

    if (!roomName || typeof roomName !== "string" || roomName.length > 128) {
      return new Response(
        JSON.stringify({ error: "Invalid roomName" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Service-role client for trusted role derivation (bypass RLS for membership checks)
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ==========================================================
    // SERVER-SIDE ROLE DERIVATION — never trust the client
    // ==========================================================
    let role: Role = "viewer";
    let canPublish = false;

    if (roomName.startsWith("call-")) {
      // Private 1:1 / group call — verify the user is a participant of the conversation
      const conversationId = roomName.slice("call-".length);
      // Conversation IDs are UUIDs; reject anything else early
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(conversationId)) {
        return new Response(JSON.stringify({ error: "Invalid call room" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: participant, error: partErr } = await adminClient
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();

      if (partErr || !participant) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // In a private call, both participants are peers (publish + subscribe)
      role = "host";
      canPublish = true;
    } else if (roomName.startsWith("live-")) {
      // Public live — derive role from live ownership in DB
      const liveId = roomName.slice("live-".length);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(liveId)) {
        return new Response(JSON.stringify({ error: "Invalid live room" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: live } = await adminClient
        .from("live_streams")
        .select("user_id")
        .eq("id", liveId)
        .maybeSingle();

      if (live && live.user_id === userId) {
        role = "host";
        canPublish = true;
      } else {
        role = "viewer";
        canPublish = false;
      }
    } else {
      // Unknown room pattern — default to most restrictive
      role = "viewer";
      canPublish = false;
    }

    const { data: profile } = await adminClient
      .from("profiles")
      .select("name, avatar_url")
      .eq("user_id", userId)
      .single();

    const name = profile?.name || "Utilisateur";

    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY")!;
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET")!;

    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: userId,
      name,
      metadata: JSON.stringify({ avatar_url: profile?.avatar_url, role }),
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish,                 // strictly server-derived
      canSubscribe: true,         // viewers may listen/watch
      canPublishData: canPublish, // data channel only for publishers
      canUpdateOwnMetadata: false,
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
      roomRecord: false,
      hidden: false,
    });

    const jwt = await at.toJwt();
    const livekitUrl = Deno.env.get("LIVEKIT_URL")!;

    // Audit log (best-effort, non-blocking semantics)
    try {
      await adminClient.from("audit_logs").insert({
        user_id: userId,
        event_type: "livekit_token_issued",
        live_id: roomName.startsWith("live-") ? roomName.slice(5) : null,
        conversation_id: roomName.startsWith("call-") ? roomName.slice(5) : null,
        metadata: { role, can_publish: canPublish, room: roomName },
      });
    } catch (_) { /* ignore audit failure */ }

    return new Response(
      JSON.stringify({ token: jwt, url: livekitUrl, role }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("LiveKit token error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
