// Lot A2 — Sealed Sender: anonymous relay.
//
// Called WITHOUT Authorization header (so server has no auth.uid linking the
// row to the sender). Accepts a delivery token previously minted by
// `sealed-mint-token`, validates HMAC + freshness + single-use, then inserts
// the sealed payload via service role. The row records ONLY the recipient
// and an opaque anonymous_sender_tag chosen by the sender.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const enc = new TextEncoder();

async function hmacB64Url(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token || "");
    const conversationId = String(body?.conversation_id || "");
    const anonymousTag = String(body?.anonymous_sender_tag || "");
    const sealedPayload = String(body?.sealed_payload || "");
    const sealedHeader = body?.sealed_header && typeof body.sealed_header === "object" ? body.sealed_header : {};

    if (!token || !conversationId || !anonymousTag || !sealedPayload) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (sealedPayload.length > 500_000) {
      return new Response(JSON.stringify({ error: "payload_too_large" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // token = recipient.exp.nonce.sig
    const parts = token.split(".");
    if (parts.length !== 4) {
      return new Response(JSON.stringify({ error: "bad_token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const [recipient, expStr, nonce, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) {
      return new Response(JSON.stringify({ error: "expired" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const expectedSig = await hmacB64Url(SERVICE_KEY, `${recipient}.${expStr}.${nonce}`);
    if (!ctEq(expectedSig, sig)) {
      return new Response(JSON.stringify({ error: "bad_signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const tokenHash = await sha256Hex(token);

    // Atomic single-use: only consume rows that haven't been consumed yet.
    const { data: claimed, error: claimErr } = await admin
      .from("sealed_delivery_tokens")
      .update({ consumed_at: new Date().toISOString() })
      .eq("token_hash", tokenHash)
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .eq("recipient_user_id", recipient)
      .select("token_hash")
      .maybeSingle();
    if (claimErr || !claimed) {
      return new Response(JSON.stringify({ error: "token_used_or_unknown" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: inserted, error: insErr } = await admin
      .from("sealed_sender_messages")
      .insert({
        conversation_id: conversationId,
        recipient_user_id: recipient,
        anonymous_sender_tag: anonymousTag,
        sealed_payload: sealedPayload,
        sealed_header: sealedHeader,
      })
      .select("id")
      .single();
    if (insErr) {
      console.error("[sealed-relay] insert failed", insErr);
      return new Response(JSON.stringify({ error: "store_failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Anonymized event row (no sender_user_id ever).
    await admin.from("sealed_sender_events").insert({
      conversation_id: conversationId,
      anonymous_sender_tag: anonymousTag,
      sender_hint_hash: null,
      recipient_user_id: recipient,
    });

    return new Response(JSON.stringify({ id: inserted.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[sealed-relay] error", e);
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
