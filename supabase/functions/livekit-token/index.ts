import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";
import { createAegisDiagnostic } from "../_shared/aegisDiagnostics.mjs";

type Role = "viewer" | "host" | "moderator";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(
  corsHeaders: Record<string, string>,
  status: number,
  body: Record<string, unknown>,
  diagnosticId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-aegis-diagnostic-id": diagnosticId,
      "Access-Control-Expose-Headers": "x-aegis-diagnostic-id",
    },
  });
}

function isSecureLiveKitUrl(value: string | undefined): value is string {
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const diagnostic = createAegisDiagnostic("livekit-token", {
    logLevel: Deno.env.get("AEGIS_LOG_LEVEL"),
    debugUntil: Deno.env.get("AEGIS_DEBUG_UNTIL"),
  });
  const json = (status: number, body: Record<string, unknown>) => {
    diagnostic.finish(status, body.error);
    return jsonResponse(corsHeaders, status, body, diagnostic.id);
  };

  diagnostic.step("method");
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  try {
    diagnostic.step("bearer_syntax");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { error: "NOT_AUTHENTICATED" });
    }

    diagnostic.step("configuration");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const livekitUrl = Deno.env.get("LIVEKIT_URL");
    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY");
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    if (
      !supabaseUrl
      || !anonKey
      || !serviceRoleKey
      || !isSecureLiveKitUrl(livekitUrl)
      || !livekitApiKey
      || !livekitApiSecret
    ) {
      return json(503, { error: "CALL_SERVICE_UNAVAILABLE" });
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    diagnostic.step("auth_session");
    const { data: authData, error: userError } = await callerClient.auth.getUser();
    const user = authData.user;
    if (userError || !user) return json(401, { error: "NOT_AUTHENTICATED" });
    const userId = user.id;

    diagnostic.step("rate_limit");
    const rateLimited = await checkRateLimitDB(`livekit:${userId}`, 10, 60, corsHeaders);
    if (rateLimited) {
      diagnostic.finish(429, "CALL_RATE_LIMITED");
      const headers = new Headers(rateLimited.headers);
      for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
      headers.set("Cache-Control", "no-store");
      headers.set("x-aegis-diagnostic-id", diagnostic.id);
      headers.set("Access-Control-Expose-Headers", "x-aegis-diagnostic-id");
      return new Response(rateLimited.body, { status: 429, headers });
    }

    diagnostic.step("request_shape");
    const body = await req.json().catch(() => null) as { roomName?: unknown; deviceId?: unknown } | null;
    const roomName = typeof body?.roomName === "string" ? body.roomName.trim() : "";
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    if (
      roomName.length === 0
      || roomName.length > 128
      || (!roomName.startsWith("call-") && !roomName.startsWith("live-"))
    ) {
      return json(400, { error: "INVALID_REQUEST" });
    }

    let role: Role = "viewer";
    let canPublish = false;
    let tokenIdentity = userId;
    let auditConversationId: string | null = null;
    let auditLiveId: string | null = null;
    // Durée du jeton : 10 min pour les appels, 75 min pour les lives (limite 1 h + marge)
    let tokenTtl = "10m";

    diagnostic.step("room_lookup");
    if (roomName.startsWith("call-")) {
      const callId = roomName.slice(5);
      if (!UUID_RE.test(callId) || deviceId.length < 8 || deviceId.length > 200) {
        return json(400, { error: "INVALID_REQUEST" });
      }

      const { data: call, error: callError } = await adminClient
        .from("active_calls")
        .select("id, conversation_id, caller_id, caller_device_id, room_name, status, protocol_version")
        .eq("id", callId)
        .eq("room_name", roomName)
        .maybeSingle();
      if (callError) return json(503, { error: "CALL_STATE_LOOKUP_FAILED" });
      if (
        !call
        || call.protocol_version !== 5
        || !["ringing", "answered", "accepted"].includes(call.status)
      ) {
        return json(403, { error: "CALL_NOT_JOINABLE" });
      }

      diagnostic.step("device_authorization");
      const { data: authorizedDevice, error: deviceError } = await adminClient
        .from("user_devices")
        .select("device_id")
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("is_active", true)
        .is("revoked_at", null)
        .eq("approval_status", "approved")
        .eq("binding_status", "bound")
        .eq("routing_status", "ready")
        .eq("lifecycle_status", "ready")
        .maybeSingle();
      if (deviceError) return json(503, { error: "CALL_DEVICE_LOOKUP_FAILED" });
      if (!authorizedDevice) return json(403, { error: "CALL_DEVICE_NOT_AUTHORIZED" });

      diagnostic.step("invitation_authorization");
      let invited = call.caller_id === userId && call.caller_device_id === deviceId;
      if (!invited) {
        const { data: invitation, error: invitationError } = await adminClient
          .from("aegis_call_invitations")
          .select("status")
          .eq("call_id", callId)
          .eq("recipient_user_id", userId)
          .eq("recipient_device_id", deviceId)
          .in("status", ["pending", "accepted"])
          .maybeSingle();
        if (invitationError) return json(503, { error: "CALL_INVITATION_LOOKUP_FAILED" });
        invited = Boolean(invitation);
      }
      if (!invited) return json(403, { error: "CALL_DEVICE_NOT_INVITED" });

      role = "host";
      canPublish = true;
      tokenIdentity = `${userId}:${deviceId}`;
      auditConversationId = call.conversation_id;
    } else {
      const liveId = roomName.slice(5);
      if (!UUID_RE.test(liveId)) return json(400, { error: "INVALID_REQUEST" });
      const { data: live, error: liveError } = await adminClient
        .from("live_streams")
        .select("user_id, is_active, started_at")
        .eq("id", liveId)
        .maybeSingle();
      if (liveError) return json(503, { error: "CALL_SERVICE_UNAVAILABLE" });
      if (!live || live.is_active !== true) return json(403, { error: "CALL_NOT_JOINABLE" });
      // Limite de durée : un live ne peut pas dépasser 60 minutes (fail-closed côté jeton)
      if (live.started_at && Date.now() - new Date(live.started_at).getTime() > 60 * 60 * 1000) {
        return json(403, { error: "LIVE_DURATION_EXCEEDED" });
      }
      tokenTtl = "75m";
      if (live.user_id === userId) {
        role = "host";
        canPublish = true;
      }
      auditLiveId = liveId;
    }

    diagnostic.step("profile_lookup");
    const { data: profile } = await adminClient
      .from("profiles")
      .select("name, avatar_url")
      .eq("user_id", userId)
      .maybeSingle();

    diagnostic.step("token_signing");
    const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: tokenIdentity,
      name: profile?.name || "Utilisateur",
      metadata: JSON.stringify({ avatar_url: profile?.avatar_url, role }),
      ttl: tokenTtl,
    });
    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish,
      canSubscribe: true,
      canPublishData: canPublish,
      canUpdateOwnMetadata: false,
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
      roomRecord: false,
      hidden: false,
    });
    const token = await accessToken.toJwt();

    diagnostic.step("audit_log");
    await adminClient.from("audit_logs").insert({
      user_id: userId,
      event_type: "livekit_token_issued",
      live_id: auditLiveId,
      conversation_id: auditConversationId,
      metadata: {
        role,
        can_publish: canPublish,
        protocol_version: roomName.startsWith("call-") ? 5 : null,
        diagnostic_id: diagnostic.id,
      },
    }).then(() => undefined, () => undefined);

    return json(200, { token, url: livekitUrl, role });
  } catch {
    return json(500, { error: "CALL_SERVICE_UNAVAILABLE" });
  }
});
