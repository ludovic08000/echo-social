// Lot L6 — Key Transparency: publish a Merkle epoch.
//
// Reads pending rows from `e2ee_transparency_log` (where included_in_epoch IS NULL),
// hashes them in canonical form, keeps ForSure's duplicate-right Merkle shape, and atomically writes:
//   - a signed `e2ee_kt_tree_heads` row,
//   - one `e2ee_kt_leaves` row per included entry,
//   - flips `included_in_epoch` + `leaf_hash` on the log rows.
//
// Server signs the head with an Ed25519 key; the public key is stored in
// `e2ee_kt_signing_keys` (must match the stable operator-configured key).
//
// Auth model: relies on service role (no JWT verification). Lovable Cloud
// edge functions deploy with verify_jwt = false by default. We additionally
// require an x-cron-secret header matching KT_CRON_SECRET to lock down ad-hoc
// invocation. If the secret isn't configured, only the service role caller
// path (Authorization: Bearer <SERVICE_ROLE_KEY>) is accepted.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { assertPublishedSigningKeyMatches, validateTransparencySigningKey } from "../_shared/kt-signing-key.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const enc = (s: string) => new TextEncoder().encode(s);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function concatBytes(...arr: Uint8Array[]) {
  let n = 0;
  for (const a of arr) n += a.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arr) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)));
}

interface TransparencyEntry {
  created_at: string;
  device_id?: string | null;
  event_type: string;
  fingerprint?: string | null;
  id: string | number;
  identity_epoch?: number | null;
  payload?: unknown;
  user_id: string;
}
function canonicalLeafPayload(entry: TransparencyEntry): string {
  const sorted = {
    created_at: entry.created_at,
    device_id: entry.device_id ?? null,
    event_type: entry.event_type,
    fingerprint: entry.fingerprint ?? null,
    id: String(entry.id),
    identity_epoch: entry.identity_epoch ?? null,
    payload: entry.payload ?? {},
    user_id: entry.user_id,
  };
  return JSON.stringify(sorted);
}
async function leafHash(payload: string): Promise<string> {
  return bytesToHex(await sha256(concatBytes(new Uint8Array([0x00]), enc(payload))));
}
async function nodeHash(left: string, right: string): Promise<string> {
  return bytesToHex(
    await sha256(concatBytes(new Uint8Array([0x01]), hexToBytes(left), hexToBytes(right))),
  );
}
async function buildRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return bytesToHex(await sha256(new Uint8Array()));
  let cur = leaves.slice();
  while (cur.length > 1) {
    const nxt: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i];
      const r = i + 1 < cur.length ? cur[i + 1] : cur[i];
      nxt.push(await nodeHash(l, r));
    }
    cur = nxt;
  }
  return cur[0];
}
function signedHeadBytes(
  epoch: number,
  root: string,
  leafCount: number,
  prevEpoch: number | null,
): Uint8Array {
  return enc(
    JSON.stringify({
      epoch: String(epoch),
      leaf_count: String(leafCount),
      prev_epoch: prevEpoch === null ? null : String(prevEpoch),
      root,
    }),
  );
}

async function getOrCreateSigningKey(supabase: ReturnType<typeof createClient<any, "public">>): Promise<{ id: string; privJwk: JsonWebKey; pubJwk: JsonWebKey }> {
  const { privJwk, pubJwk } = await validateTransparencySigningKey(Deno.env.get("KT_SIGNING_PRIV_JWK"));
  const { data: row, error: lookupError } = await supabase
      .from("e2ee_kt_signing_keys")
      .select("id, public_key_jwk")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  if (lookupError) throw new Error('KT_SIGNING_KEY_LOOKUP_FAILED');
  if (row?.id) {
    assertPublishedSigningKeyMatches(row.public_key_jwk, pubJwk);
    return { id: row.id, privJwk, pubJwk };
  }
  const { data: ins, error } = await supabase
    .from("e2ee_kt_signing_keys")
    .insert({ public_key_jwk: pubJwk, algorithm: "Ed25519", active: true })
    .select("id")
    .single();
  if (error || !ins?.id) throw new Error('KT_SIGNING_KEY_PUBLISH_FAILED');
  return { id: ins.id, privJwk, pubJwk };
}

async function signEd25519(privJwk: JsonWebKey, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  // Copie exacte des octets dans un ArrayBuffer accepté par WebCrypto.
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new Uint8Array(data));
  return bytesToHex(new Uint8Array(sig));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...corsHeaders, Allow: "POST" } });

  const cronSecret = Deno.env.get("KT_CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const providedCron = req.headers.get("x-cron-secret");
  const authHeader = req.headers.get("Authorization") ?? "";
  const providedBearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  const cronOk = !!cronSecret && providedCron === cronSecret;
  const serviceOk = !!serviceRoleKey && providedBearer === serviceRoleKey;

  // Fail closed: require either a matching cron secret or the service-role bearer.
  if (!cronOk && !serviceOk) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // 1) Pull pending entries (cap batch size at 5000 per epoch).
    const { data: pending, error: pErr } = await supabase
      .from("e2ee_transparency_log")
      .select("id, user_id, event_type, fingerprint, identity_epoch, device_id, payload, created_at")
      .is("included_in_epoch", null)
      .order("id", { ascending: true })
      .limit(5000);
    if (pErr) throw pErr;
    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ status: "noop", pending: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2) Compute leaf hashes.
    const leaves: { id: string; hash: string }[] = [];
    for (const row of pending) {
      if (typeof row.id === 'number' && !Number.isSafeInteger(row.id)) throw new Error('KT_LOG_ID_UNSAFE');
      const h = await leafHash(canonicalLeafPayload(row));
      leaves.push({ id: String(row.id), hash: h });
    }
    const root = await buildRoot(leaves.map((l) => l.hash));

    // 3) Pick next epoch number + prev.
    const { data: prevHead, error: previousError } = await supabase
      .from("e2ee_kt_tree_heads")
      .select("epoch")
      .order("epoch", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previousError) throw new Error('KT_PREVIOUS_HEAD_UNAVAILABLE');
    const epoch = prevHead?.epoch ? Number(prevHead.epoch) + 1 : 1;
    const prevEpoch = prevHead?.epoch ?? null;
    if (!Number.isSafeInteger(epoch)) throw new Error('KT_EPOCH_UNSAFE');

    // 4) Sign head.
    const { id: keyId, privJwk } = await getOrCreateSigningKey(supabase);
    const signature = await signEd25519(
      privJwk,
      signedHeadBytes(epoch, root, leaves.length, prevEpoch === null ? null : Number(prevEpoch)),
    );

    // Tête, feuilles et annotations sont un seul commit : aucun succès partiel.
    const { data: committed, error: publishError } = await supabase.rpc('publish_transparency_epoch', {
      p_epoch: epoch, p_prev_epoch: prevEpoch, p_root: root,
      p_signing_key: keyId, p_signature: signature, p_leaves: leaves,
    });
    if (publishError) {
      if (publishError.code === '40001') return new Response(JSON.stringify({ error: 'KT_EPOCH_RACE', retryable: true }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
      throw new Error('KT_PUBLICATION_FAILED');
    }
    if (committed !== true) throw new Error('KT_PUBLICATION_UNCONFIRMED');

    return new Response(
      JSON.stringify({
        status: "ok",
        epoch,
        leaf_count: leaves.length,
        root,
        prev_epoch: prevEpoch,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[kt-publish-epoch]", e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
