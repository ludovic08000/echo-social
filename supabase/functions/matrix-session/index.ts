import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

type JsonRecord = Record<string, unknown>;

function json(req: Request, status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`MATRIX_CONFIG_MISSING_${name}`);
  return name.endsWith("_URL") ? value.replace(/\/+$/, "") : value;
}

async function hmacHex(algorithm: "SHA-256", secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matrixRequest(
  url: string,
  init: RequestInit,
  expected: number[],
): Promise<JsonRecord> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => ({})) as JsonRecord;
  if (!expected.includes(response.status)) {
    const code = typeof body.errcode === "string" ? body.errcode : `HTTP_${response.status}`;
    throw new Error(`MATRIX_${code}`);
  }
  return body;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json(req, 401, { error: "unauthorized" });

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const userClient = createClient(
      supabaseUrl,
      requiredEnv("SUPABASE_ANON_KEY"),
      { global: { headers: { Authorization: authorization } } },
    );
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json(req, 401, { error: "unauthorized" });

    const payload = await req.json().catch(() => ({})) as JsonRecord;
    const installationId = typeof payload.installation_id === "string"
      ? payload.installation_id.trim()
      : "";
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(installationId)) {
      return json(req, 400, { error: "invalid_installation_id" });
    }

    const homeserverUrl = requiredEnv("MATRIX_HOMESERVER_URL");
    const serverName = requiredEnv("MATRIX_SERVER_NAME").toLowerCase();
    const adminToken = requiredEnv("MATRIX_ADMIN_ACCESS_TOKEN");
    const derivationSecret = requiredEnv("MATRIX_ACCOUNT_DERIVATION_SECRET");
    const localpart = `fs_${user.id.replaceAll("-", "")}`;
    const matrixUserId = `@${localpart}:${serverName}`;
    const accountPassword = await hmacHex("SHA-256", derivationSecret, `account:${user.id}`);
    const deviceDigest = await hmacHex(
      "SHA-256",
      derivationSecret,
      `device:${user.id}:${installationId}`,
    );
    const deviceId = `FS_${deviceDigest.slice(0, 40).toUpperCase()}`;

    // Idempotently create/update the local Matrix account. The technical
    // password is deterministic server-side and never returned to the client.
    await matrixRequest(
      `${homeserverUrl}/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          password: accountPassword,
          logout_devices: false,
          admin: false,
          deactivated: false,
          displayname: typeof user.user_metadata?.name === "string"
            ? user.user_metadata.name.slice(0, 80)
            : "ForSure",
          external_ids: [{ auth_provider: "forsure-supabase", external_id: user.id }],
        }),
      },
      [200, 201],
    );

    const login = await matrixRequest(
      `${homeserverUrl}/_matrix/client/v3/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: matrixUserId },
          password: accountPassword,
          device_id: deviceId,
          initial_device_display_name:
            typeof payload.device_name === "string"
              ? `ForSure · ${payload.device_name.slice(0, 80)}`
              : "ForSure Web",
          refresh_token: true,
        }),
      },
      [200],
    );

    const service = createClient(
      supabaseUrl,
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    );
    const { error: mappingError } = await service.from("matrix_user_mappings").upsert({
      user_id: user.id,
      matrix_user_id: matrixUserId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (mappingError) throw new Error(`MATRIX_MAPPING_${mappingError.code}`);

    return json(req, 200, {
      access_token: login.access_token,
      refresh_token: login.refresh_token,
      expires_in_ms: login.expires_in_ms,
      device_id: typeof login.device_id === "string" ? login.device_id : deviceId,
      user_id: typeof login.user_id === "string" ? login.user_id : matrixUserId,
      home_server: serverName,
    });
  } catch (error) {
    console.error("[matrix-session]", error);
    const message = error instanceof Error ? error.message : "MATRIX_SESSION_FAILED";
    return json(req, 502, { error: message });
  }
});
