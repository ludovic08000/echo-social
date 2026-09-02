import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

type JsonRecord = Record<string, unknown>;

function response(req: Request, status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`MATRIX_CONFIG_MISSING_${name}`);
  return name.endsWith("_URL") ? value.replace(/\/+$/, "") : value;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response(req, 405, { error: "method_not_allowed" });

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) return response(req, 401, { error: "unauthorized" });

    const supabaseUrl = env("SUPABASE_URL");
    const authClient = createClient(
      supabaseUrl,
      env("SUPABASE_ANON_KEY"),
      { global: { headers: { Authorization: authorization } } },
    );
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return response(req, 401, { error: "unauthorized" });

    const body = await req.json().catch(() => ({})) as JsonRecord;
    const conversationId = typeof body.conversation_id === "string"
      ? body.conversation_id
      : "";
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
      return response(req, 400, { error: "invalid_conversation_id" });
    }

    const service = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: callerMembership } = await service
      .from("conversation_participants")
      .select("user_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!callerMembership) return response(req, 403, { error: "not_a_participant" });

    const { data: participants, error: participantsError } = await service
      .from("conversation_participants")
      .select("user_id")
      .eq("conversation_id", conversationId);
    if (participantsError || !participants?.length) {
      throw new Error("MATRIX_PARTICIPANTS_UNAVAILABLE");
    }

    const homeserverUrl = env("MATRIX_HOMESERVER_URL");
    const serverName = env("MATRIX_SERVER_NAME").toLowerCase();
    const adminToken = env("MATRIX_ADMIN_ACCESS_TOKEN");
    const derivationSecret = env("MATRIX_ACCOUNT_DERIVATION_SECRET");
    const matrixUsers: Array<{ user_id: string; matrix_user_id: string }> = [];

    for (const participant of participants) {
      const localpart = `fs_${participant.user_id.replaceAll("-", "")}`;
      const matrixUserId = `@${localpart}:${serverName}`;
      const password = await hmacHex(derivationSecret, `account:${participant.user_id}`);
      const provision = await fetch(
        `${homeserverUrl}/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            password,
            logout_devices: false,
            admin: false,
            deactivated: false,
            external_ids: [{
              auth_provider: "forsure-supabase",
              external_id: participant.user_id,
            }],
          }),
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (!provision.ok) throw new Error(`MATRIX_PROVISION_${provision.status}`);

      matrixUsers.push({ user_id: participant.user_id, matrix_user_id: matrixUserId });
    }

    const { error: upsertError } = await service
      .from("matrix_user_mappings")
      .upsert(matrixUsers, { onConflict: "user_id" });
    if (upsertError) throw new Error(`MATRIX_MAPPING_${upsertError.code}`);

    const { data: room } = await service
      .from("matrix_room_mappings")
      .select("matrix_room_id")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    return response(req, 200, {
      conversation_id: conversationId,
      matrix_room_id: room?.matrix_room_id ?? null,
      participants: matrixUsers,
    });
  } catch (error) {
    console.error("[matrix-route]", error);
    return response(req, 502, {
      error: error instanceof Error ? error.message : "MATRIX_ROUTE_FAILED",
    });
  }
});

