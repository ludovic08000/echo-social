import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";

/**
 * r2-presign: Returns a presigned PUT URL so the client can upload
 * directly to Cloudflare R2 — bypassing the 50 MB edge function body limit.
 *
 * POST body: { folder: string, filename: string, contentType: string, fileSize: number }
 * Response:  { uploadUrl: string, fileUrl: string, path: string }
 */

const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  avatars:       ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
  images:        ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
  "post-images": ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "video/mp4", "video/webm", "video/quicktime", "application/octet-stream"],
  videos:        ["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"],
  products:      ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  stories:       ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "video/mp4", "video/webm", "video/quicktime", "application/octet-stream"],
  backgrounds:   ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  documents:     ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"],
  voice:         ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"],
  lives:         ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "video/webm", "video/mp4"],
  feed:          ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "video/mp4", "video/webm", "video/quicktime", "application/octet-stream"],
  thumbnails:    ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  uploads:       ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "video/mp4", "video/webm", "video/quicktime", "application/octet-stream"],
};

const FOLDER_MAX_SIZES: Record<string, number> = {
  avatars: 5 * 1024 * 1024,
  images: 10 * 1024 * 1024,
  "post-images": 200 * 1024 * 1024,
  videos: 200 * 1024 * 1024, // Supports up to 200 MB via direct upload
  products: 5 * 1024 * 1024,
  stories: 10 * 1024 * 1024,
  backgrounds: 5 * 1024 * 1024,
  documents: 10 * 1024 * 1024,
  voice: 5 * 1024 * 1024,
  lives: 200 * 1024 * 1024,
  feed: 200 * 1024 * 1024,
  thumbnails: 2 * 1024 * 1024,
  uploads: 10 * 1024 * 1024,
};

// Rate limiting now DB-backed via shared helper (persistent across instances)
const RATE_LIMIT = 20;
const RATE_WINDOW_S = 60;

// CORS — restricted to actual app domains + Lovable preview
const ALLOWED_ORIGINS = [
  "https://calm-connect-05.lovable.app",
  "https://forsure.fans",
  "https://www.forsure.fans",
];
function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--[a-f0-9-]+\.lovable\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lovableproject\.com$/.test(origin)) return true;
  return false;
}
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const ok = isAllowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...h, "Content-Type": "application/json" } });

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Non authentifié");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    const userId = claimsData?.claims?.sub as string | undefined;
    if (claimsError || !userId) throw new Error("Non authentifié");
    const rateLimited = await checkRateLimitDB(`presign:${userId}`, RATE_LIMIT, RATE_WINDOW_S, h);
    if (rateLimited) return rateLimited;

    const { folder, filename, contentType, fileSize } = await req.json();
    if (!folder || !filename || !contentType || !fileSize) throw new Error("Paramètres manquants");

    const cleanFolder = folder.replace(/[^a-zA-Z0-9\-_]/g, "");
    const baseMime = contentType.split(";")[0].trim();
    const allowed = ALLOWED_MIME_TYPES[cleanFolder] || ALLOWED_MIME_TYPES["uploads"];
    if (!allowed.includes(baseMime)) throw new Error(`Type non autorisé: ${baseMime}`);

    const maxSize = FOLDER_MAX_SIZES[cleanFolder] || 10 * 1024 * 1024;
    if (fileSize > maxSize) throw new Error(`Fichier trop volumineux (max ${Math.round(maxSize / 1024 / 1024)} Mo)`);

    // User folder
    const serviceClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await serviceClient.from("profiles").select("name").eq("user_id", userId).single();
    const rawName = profile?.name || "user";
    const sanitizedName = rawName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "user";
    const userFolder = `${sanitizedName}-${userId.substring(0, 8)}`;

    const ext = filename.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 5) || "bin";
    const filePath = `${userFolder}/${cleanFolder}/${Date.now()}.${ext}`;

    // R2 config
    const accountId = Deno.env.get("R2_ACCOUNT_ID")?.trim() ?? "";
    let accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID")?.trim() ?? "";
    let secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY")?.trim() ?? "";
    const bucketName = Deno.env.get("R2_BUCKET_NAME")?.trim() ?? "";
    const publicUrl = Deno.env.get("R2_PUBLIC_URL")?.trim() ?? "";
    if (accessKeyId.length === 64 && secretAccessKey.length === 32) {
      [accessKeyId, secretAccessKey] = [secretAccessKey, accessKeyId];
    }
    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) throw new Error("R2 non configuré");

    const r2Region = Deno.env.get("R2_REGION")?.trim() || "";
    const regionPrefix = r2Region ? `${r2Region}.` : "";
    const host = `${accountId}.${regionPrefix}r2.cloudflarestorage.com`;
    const endpoint = `https://${host}`;

    // Generate presigned PUT URL (valid 15 min)
    const expiresSec = 900;
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const shortDate = dateStamp.substring(0, 8);
    const credentialScope = `${shortDate}/auto/s3/aws4_request`;
    const credential = `${accessKeyId}/${credentialScope}`;

    const queryParams: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": credential,
      "X-Amz-Date": dateStamp,
      "X-Amz-Expires": String(expiresSec),
      "X-Amz-SignedHeaders": "content-type;host",
    };

    const queryString = Object.keys(queryParams).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join("&");
    const canonicalHeaders = `content-type:${baseMime}\nhost:${host}\n`;
    const canonicalRequest = [
      "PUT",
      `/${bucketName}/${filePath}`,
      queryString,
      canonicalHeaders,
      "content-type;host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      dateStamp,
      credentialScope,
      await sha256Hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretAccessKey}`), shortDate);
    const kRegion = await hmacSha256(kDate, "auto");
    const kService = await hmacSha256(kRegion, "s3");
    const signingKey = await hmacSha256(kService, "aws4_request");
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    const uploadUrl = `${endpoint}/${bucketName}/${filePath}?${queryString}&X-Amz-Signature=${signature}`;
    const fileUrl = `${publicUrl.replace(/\/$/, "")}/${filePath}`;

    return new Response(JSON.stringify({ uploadUrl, fileUrl, path: filePath }), {
      headers: { ...h, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("r2-presign error:", e);
    const msg = e instanceof Error ? e.message : "Erreur interne";
    return new Response(JSON.stringify({ error: msg }), {
      status: 400, headers: { ...cors(req), "Content-Type": "application/json" },
    });
  }
});

// ─── Crypto helpers ───
async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
async function hmacSha256(key: Uint8Array | ArrayBuffer, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key instanceof Uint8Array ? key : new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}
function toHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
