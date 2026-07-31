import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { safeServerErrorMeta, safeServerLog } from "../_shared/aegis-privacy.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function json(headers: Record<string, string>, status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(corsHeaders, 401, { error: "UNAUTHORIZED" });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json(corsHeaders, 401, { error: "UNAUTHORIZED" });

    const request = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof request.action === "string" ? request.action : "";

    // Aegis peer-message plaintext never reaches a server function. Moderation
    // can only act on user reports and metadata after the recipient explicitly
    // reports content from their own device.
    if (action === "moderate_message") {
      return json(corsHeaders, 410, {
        error: "E2EE_MESSAGE_CONTENT_UNAVAILABLE",
        safe: null,
      });
    }

    if (action !== "accept_request" && action !== "reject_request") {
      return json(corsHeaders, 400, { error: "INVALID_ACTION" });
    }

    const conversationId = typeof request.conversationId === "string"
      ? request.conversationId
      : "";
    if (!UUID_RE.test(conversationId)) {
      return json(corsHeaders, 400, { error: "INVALID_CONVERSATION" });
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: participant, error: participantError } = await admin
      .from("conversation_participants")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (participantError) {
      safeServerLog("message-request", "PARTICIPANT_LOOKUP_FAILED", safeServerErrorMeta(participantError));
      return json(corsHeaders, 500, { error: "INTERNAL" });
    }
    if (!participant) return json(corsHeaders, 403, { error: "NOT_PARTICIPANT" });

    const nextStatus = action === "accept_request" ? "delivered" : "blocked";
    const { error: updateError } = await admin
      .from("messages")
      .update({ status: nextStatus })
      .eq("conversation_id", conversationId)
      .eq("status", "pending");
    if (updateError) {
      safeServerLog("message-request", "STATUS_UPDATE_FAILED", safeServerErrorMeta(updateError));
      return json(corsHeaders, 500, { error: "INTERNAL" });
    }

    return json(corsHeaders, 200, action === "accept_request"
      ? { accepted: true }
      : { rejected: true });
  } catch (error) {
    safeServerLog("message-request", "UNHANDLED", safeServerErrorMeta(error));
    return json(corsHeaders, 500, { error: "INTERNAL" });
  }
});
