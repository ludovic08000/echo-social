// Web Push (VAPID + aes128gcm payload encryption) — RFC 8030 / RFC 8291
// Sends real push notifications to subscribed devices.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// ───────────────────── helpers ─────────────────────
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
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// Convert raw P-256 public key (65 bytes, 04|X|Y) to JWK
function rawP256ToJwk(raw: Uint8Array, isPrivate = false, d?: Uint8Array): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("Invalid raw P-256 key");
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(x),
    y: b64urlEncode(y),
  };
  if (isPrivate && d) jwk.d = b64urlEncode(d);
  return jwk;
}

async function importVapidPrivateKey(privateKeyB64u: string, publicKeyB64u: string): Promise<CryptoKey> {
  const d = b64urlDecode(privateKeyB64u);
  const pub = b64urlDecode(publicKeyB64u);
  const jwk = rawP256ToJwk(pub, true, d);
  return await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

// Build VAPID JWT (ES256) for a given audience
async function buildVapidJwt(audience: string, subject: string, vapidKey: CryptoKey): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const payload = { aud: audience, exp, sub: subject };
  const enc = new TextEncoder();
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
  const sigDer = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapidKey, signingInput);
  // WebCrypto returns r||s (64 bytes for P-256) directly — ready for JWS
  const sig = new Uint8Array(sigDer);
  return `${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

// HKDF
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// aes128gcm content encoding (RFC 8188) for Web Push (RFC 8291)
async function encryptAes128Gcm(payload: Uint8Array, p256dhRaw: Uint8Array, authSecret: Uint8Array): Promise<Uint8Array> {
  // Generate ephemeral ECDH P-256 keypair
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));

  // Import recipient public key
  const recipientPub = await crypto.subtle.importKey(
    "raw",
    p256dhRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // Shared ECDH secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPub },
    eph.privateKey,
    256
  );
  const ecdhSecret = new Uint8Array(sharedBits);

  // Per RFC 8291: PRK_key = HKDF(authSecret, ecdhSecret, info="WebPush: info\x00" || ua_pub || as_pub, 32)
  const enc = new TextEncoder();
  const keyInfo = concat(
    enc.encode("WebPush: info\0"),
    p256dhRaw,
    ephPubRaw
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // Salt: 16 random bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm\x00", 16)
  const cek = await hkdf(salt, ikm, concat(enc.encode("Content-Encoding: aes128gcm\0")), 16);
  // NONCE = HKDF(salt, ikm, "Content-Encoding: nonce\x00", 12)
  const nonce = await hkdf(salt, ikm, concat(enc.encode("Content-Encoding: nonce\0")), 12);

  // Pad: append 0x02 (final record delimiter); single-record encoding
  const padded = concat(payload, new Uint8Array([0x02]));

  // AES-GCM encrypt
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // Build aes128gcm header: salt(16) | rs(4 BE = 4096) | idlen(1=65) | keyid(ephemeral pub raw 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idlen = new Uint8Array([ephPubRaw.length]);
  const header = concat(salt, rs, idlen, ephPubRaw);

  return concat(header, ct);
}

// ───────────────────── handler ─────────────────────
Deno.serve(async (req) => {
  const headers = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers });

  try {
    // Require authenticated caller. Senders can only push to themselves;
    // admins / service role can push to anyone (used for system notifications).
    const { requireAuthenticated } = await import("../_shared/auth-guard.ts");
    const authed = await requireAuthenticated(req, headers);
    if (!("userId" in authed)) return authed.response;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { user_id, title, body: msgBody, url, icon, tag, kind, requireInteraction } = body;
    if (!user_id || !title) {
      return new Response(JSON.stringify({ error: "user_id and title required" }), {
        status: 400, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    // Non-admin callers may only push to themselves.
    if (user_id !== authed.userId) {
      const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: authed.userId, _role: "admin" });
      if (isAdmin !== true) {
        return new Response(JSON.stringify({ error: "FORBIDDEN" }), {
          status: 403, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }

    const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY");
    const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY");
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:contact@forsure.fans";

    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(JSON.stringify({ status: "ok", sent: 0, reason: "vapid_not_configured" }),
        { headers: { ...headers, "Content-Type": "application/json" } });
    }

    const { data: subs } = await supabase
      .from("push_subscriptions").select("*").eq("user_id", user_id);

    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ status: "ok", sent: 0, reason: "no_subscriptions" }),
        { headers: { ...headers, "Content-Type": "application/json" } });
    }

    let vapidKey: CryptoKey;
    try {
      vapidKey = await importVapidPrivateKey(VAPID_PRIVATE, VAPID_PUBLIC);
    } catch (e) {
      console.error("VAPID import failed", e);
      return new Response(JSON.stringify({ error: "vapid_invalid" }), {
        status: 500, headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({
      title, body: msgBody || "", icon: icon || "/pwa-192x192.png",
      badge: "/pwa-192x192.png", url: url || "/notifications",
      tag, kind, requireInteraction: !!requireInteraction,
      timestamp: Date.now(),
    });
    const payloadBytes = new TextEncoder().encode(payload);

    let sent = 0;
    const expired: string[] = [];

    for (const sub of subs as any[]) {
      try {
        const endpoint: string = sub.endpoint;
        const p256dh: string = sub.p256dh || sub.keys?.p256dh;
        const auth: string = sub.auth || sub.keys?.auth;
        if (!endpoint || !p256dh || !auth) {
          expired.push(sub.id); continue;
        }

        const u = new URL(endpoint);
        const audience = `${u.protocol}//${u.host}`;
        const jwt = await buildVapidJwt(audience, VAPID_SUBJECT, vapidKey);

        const cipher = await encryptAes128Gcm(
          payloadBytes,
          b64urlDecode(p256dh),
          b64urlDecode(auth),
        );

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Authorization": `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": "60",
            "Urgency": kind === "call_incoming" ? "high" : "normal",
          },
          body: cipher,
        });

        if (res.status === 201 || res.status === 200) {
          sent++;
        } else if (res.status === 404 || res.status === 410) {
          expired.push(sub.id);
        } else {
          const txt = await res.text().catch(() => "");
          console.warn(`Push ${sub.id} failed ${res.status}: ${txt.slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`Push subscription ${sub.id} threw`, err);
      }
    }

    if (expired.length > 0) {
      await supabase.from("push_subscriptions").delete().in("id", expired);
    }

    return new Response(JSON.stringify({ status: "ok", sent, expired: expired.length }),
      { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("push-notify error", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...headers, "Content-Type": "application/json" },
    });
  }
});
