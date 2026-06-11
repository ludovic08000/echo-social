// Lot A2 — Sealed Sender: mint a short-lived single-use delivery token.
//
// The sender authenticates here (JWT in Authorization header), proves to the
// server it is a legitimate user, and receives an opaque token bound to a
// specific recipient + expiry. The server stores ONLY a hash of the token,
// then forgets which sender minted it. The companion `sealed-relay` function
// accepts that token without any auth header, so the row eventually inserted
// into `sealed_sender_messages` cannot be linked back to the sender via
// auth.uid() or service-role audit logs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TOKEN_TTL_MS = 5 * 60_000; // 5 minutes
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return new Uint8Array(sig);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing_auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify JWT via auth.getUser; we only need confirmation it's a real user.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) {
      return new Response(JSON.stringify({ error: "invalid_auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const recipient = String(body?.recipient_user_id || "");
    if (!recipient || !/^[0-9a-f-]{36}$/i.test(recipient)) {
      return new Response(JSON.stringify({ error: "bad_recipient" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    // Token format: <recipient>.<expMs>.<nonce>.<sig>
    const base = `${recipient}.${expiresAt}.${nonce}`;
    const sig = b64url(await hmac(SERVICE_KEY, base));
    const token = `${base}.${sig}`;
    const tokenHash = await sha256Hex(token);

    // Persist hash only — service role bypasses RLS.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { error: insErr } = await admin
      .from("sealed_delivery_tokens")
      .insert({
        token_hash: tokenHash,
        recipient_user_id: recipient,
        expires_at: new Date(expiresAt).toISOString(),
      });
    if (insErr) {
      console.error("[sealed-mint] insert failed", insErr);
      return new Response(JSON.stringify({ error: "store_failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ token, expires_at: expiresAt }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[sealed-mint] error", e);
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
