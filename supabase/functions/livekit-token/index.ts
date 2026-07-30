import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";

type Role = "viewer" | "host" | "moderator";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(corsHeaders: Record<string, string>, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json(corsHeaders, 401, { error: "Unauthorized" });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return json(corsHeaders, 401, { error: "Unauthorized" });

    const userId = user.id;
    const rateLimited = await checkRateLimitDB(`livekit:${userId}`, 10, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const body = await req.json().catch(() => ({}));
    const roomName = body?.roomName;
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    if (!roomName || typeof roomName !== "string" || roomName.length > 128) {
      return json(corsHeaders, 400, { error: "Invalid roomName" });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let role: Role = "viewer";
    let canPublish = false;
    let tokenIdentity = userId;
    let auditConversationId: string | null = null;
    let auditCallId: string | null = null;

    if (roomName.startsWith("call-")) {
      const callId = roomName.slice(5);
      if (!UUID_RE.test(callId) || deviceId.length < 8 || deviceId.length > 200) {
        return json(corsHeaders, 400, { error: "Invalid call room or device" });
      }

      const { data: call, error: callError } = await adminClient
        .from("active_calls")
        .select("id, conversation_id, caller_id, caller_device_id, room_name, status, protocol_version")
        .eq("id", callId)
        .eq("room_name", roomName)
        .maybeSingle();
      if (
        callError ||
        !call ||
        call.protocol_version !== 5 ||
        !["ringing", "answered", "accepted"].includes(call.status)
      ) {
        return json(corsHeaders, 403, { error: "Call is not joinable" });
      }

      const { data: authorizedDevice } = await adminClient
        .from("user_devices")
        .select("device_id")
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("is_active", true)
        .is("revoked_at", null)
        .eq("approval_status", "approved")
        .neq("routing_status", "unavailable")
        .maybeSingle();
      if (!authorizedDevice) return json(corsHeaders, 403, { error: "Device is not authorized" });

      let invited = call.caller_id === userId && call.caller_device_id === deviceId;
      if (!invited) {
        const { data: invitation } = await adminClient
          .from("aegis_call_invitations")
          .select("status")
          .eq("call_id", callId)
          .eq("recipient_user_id", userId)
          .eq("recipient_device_id", deviceId)
          .in("status", ["pending", "accepted"])
          .maybeSingle();
        invited = Boolean(invitation);
      }
      if (!invited) return json(corsHeaders, 403, { error: "No invitation for this device" });

      role = "host";
      canPublish = true;
      tokenIdentity = `${userId}:${deviceId}`;
      auditConversationId = call.conversation_id;
      auditCallId = callId;
    } else if (roomName.startsWith("live-")) {
      const liveId = roomName.slice(5);
      if (!UUID_RE.test(liveId)) return json(corsHeaders, 400, { error: "Invalid live room" });

      const { data: live } = await adminClient
        .from("live_streams")
        .select("user_id")
        .eq("id", liveId)
        .maybeSingle();
      if (live?.user_id === userId) {
        role = "host";
        canPublish = true;
      }
    }

    const { data: profile } = await adminClient
      .from("profiles")
      .select("name, avatar_url")
      .eq("user_id", userId)
      .single();

    const at = new AccessToken(
      Deno.env.get("LIVEKIT_API_KEY")!,
      Deno.env.get("LIVEKIT_API_SECRET")!,
      {
        identity: tokenIdentity,
        name: profile?.name || "Utilisateur",
        metadata: JSON.stringify({
          avatar_url: profile?.avatar_url,
          role,
          ...(auditCallId ? { call_id: auditCallId, device_id: deviceId } : {}),
        }),
      },
    );

    at.addGrant({
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

    try {
      await adminClient.from("audit_logs").insert({
        user_id: userId,
        event_type: "livekit_token_issued",
        live_id: roomName.startsWith("live-") ? roomName.slice(5) : null,
        conversation_id: auditConversationId,
        metadata: {
          role,
          can_publish: canPublish,
          room: roomName,
          ...(auditCallId ? { call_id: auditCallId, device_id: deviceId } : {}),
        },
      });
    } catch {
      // Audit logging is best-effort and never widens token permissions.
    }

    return json(corsHeaders, 200, {
      token: await at.toJwt(),
      url: Deno.env.get("LIVEKIT_URL")!,
      role,
    });
  } catch (error) {
    console.error("LiveKit token error:", error);
    return json(corsHeaders, 500, { error: "Internal server error" });
  }
});
