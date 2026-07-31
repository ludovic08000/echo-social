// Privacy-safe Web Push (VAPID + aes128gcm payload encryption).
// Callers select an event kind only. Titles, bodies, routes and identifiers are
// constructed here so message plaintext can never reach a lock-screen payload.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  buildPrivacySafePushPayload,
  normalizeAegisPushKind,
  safeServerErrorMeta,
  safeServerLog,
} from "../_shared/aegis-privacy.ts";

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function rawP256ToJwk(raw: Uint8Array, isPrivate = false, d?: Uint8Array): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("VAPID_KEY_INVALID");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(raw.slice(1, 33)),
    y: b64urlEncode(raw.slice(33, 65)),
  };
  if (isPrivate && d) jwk.d = b64urlEncode(d);
  return jwk;
}

async function importVapidPrivateKey(privateKeyB64u: string, publicKeyB64u: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    rawP256ToJwk(b64urlDecode(publicKeyB64u), true, b64urlDecode(privateKeyB64u)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function buildVapidJwt(audience: string, subject: string, vapidKey: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    vapidKey,
    signingInput,
  ));
  return `${headerB64}.${payloadB64}.${b64urlEncode(signature)}`;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  ));
}

async function encryptAes128Gcm(
  payload: Uint8Array,
  p256dhRaw: Uint8Array,
  authSecret: Uint8Array,
): Promise<Uint8Array> {
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const recipientPub = await crypto.subtle.importKey(
    "raw",
    p256dhRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPub },
    eph.privateKey,
    256,
  ));
  const enc = new TextEncoder();
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(enc.encode("WebPush: info\0"), p256dhRaw, ephPubRaw),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    concat(payload, new Uint8Array([0x02])),
  ));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([ephPubRaw.length]), ephPubRaw, ciphertext);
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
}

Deno.serve(async (req) => {
  const headers = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers });

  try {
    const { requireAuthenticated } = await import("../_shared/auth-guard.ts");
    const authed = await requireAuthenticated(req, headers);
    if (!("userId" in authed)) return authed.response;

    const request = await req.json().catch(() => ({})) as Record<string, unknown>;
    const userId = typeof request.user_id === "string" ? request.user_id : "";
    const kind = normalizeAegisPushKind(request.kind);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(userId)) {
      return new Response(JSON.stringify({ error: "INVALID_RECIPIENT" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    if (userId !== authed.userId) {
      const { data: isAdmin } = await supabase.rpc("has_role", {
        _user_id: authed.userId,
        _role: "admin",
      });
      if (isAdmin !== true) {
        return new Response(JSON.stringify({ error: "FORBIDDEN" }), {
          status: 403,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }

    const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:contact@forsure.fans";
    if (!vapidPublic || !vapidPrivate) {
      return new Response(JSON.stringify({ status: "ok", sent: 0, reason: "vapid_not_configured" }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const { data: subscriptions } = await supabase
      .from("push_subscriptions")
      .select("id,endpoint,p256dh,auth")
      .eq("user_id", userId);
    const rows = (subscriptions ?? []) as PushSubscriptionRow[];
    if (rows.length === 0) {
      return new Response(JSON.stringify({ status: "ok", sent: 0, reason: "no_subscriptions" }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let vapidKey: CryptoKey;
    try {
      vapidKey = await importVapidPrivateKey(vapidPrivate, vapidPublic);
    } catch (error) {
      safeServerLog("push", "VAPID_IMPORT_FAILED", safeServerErrorMeta(error));
      return new Response(JSON.stringify({ error: "VAPID_INVALID" }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const payloadBytes = new TextEncoder().encode(JSON.stringify(buildPrivacySafePushPayload({
      kind,
      requireInteraction: request.requireInteraction,
    })));
    let sent = 0;
    const expired: string[] = [];

    for (const subscription of rows) {
      try {
        if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) {
          expired.push(subscription.id);
          continue;
        }
        const endpoint = new URL(subscription.endpoint);
        const jwt = await buildVapidJwt(
          `${endpoint.protocol}//${endpoint.host}`,
          vapidSubject,
          vapidKey,
        );
        const cipher = await encryptAes128Gcm(
          payloadBytes,
          b64urlDecode(subscription.p256dh),
          b64urlDecode(subscription.auth),
        );
        const response = await fetch(subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${jwt}, k=${vapidPublic}`,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "60",
            Urgency: kind === "call_incoming" ? "high" : "normal",
          },
          body: cipher,
        });
        if (response.status === 200 || response.status === 201) sent += 1;
        else if (response.status === 404 || response.status === 410) expired.push(subscription.id);
        else safeServerLog("push", "PROVIDER_REJECTED", { status_code: response.status, kind });
      } catch (error) {
        safeServerLog("push", "SUBSCRIPTION_DELIVERY_FAILED", {
          ...safeServerErrorMeta(error),
          kind,
        });
      }
    }

    if (expired.length > 0) {
      await supabase.from("push_subscriptions").delete().in("id", expired);
    }
    return new Response(JSON.stringify({ status: "ok", sent, expired: expired.length }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    safeServerLog("push", "UNHANDLED", safeServerErrorMeta(error));
    return new Response(JSON.stringify({ error: "INTERNAL" }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
});
