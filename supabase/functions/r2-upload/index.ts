import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Security constants ───
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB absolute max
const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  avatars:     ["image/jpeg", "image/png", "image/webp", "image/gif"],
  images:      ["image/jpeg", "image/png", "image/webp", "image/gif"],
  "post-images": ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"],
  videos:      ["video/mp4", "video/webm", "video/quicktime"],
  products:    ["image/jpeg", "image/png", "image/webp"],
  stories:     ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"],
  backgrounds: ["image/jpeg", "image/png", "image/webp"],
  documents:   ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  voice:       ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"],
  lives:       ["image/jpeg", "image/png", "image/webp", "video/webm", "video/mp4"],
  feed:        ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"],
  thumbnails:  ["image/jpeg", "image/png", "image/webp"],
  uploads:     ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"],
};
const FOLDER_MAX_SIZES: Record<string, number> = {
  avatars: 5 * 1024 * 1024,
  images: 10 * 1024 * 1024,
  "post-images": 200 * 1024 * 1024,
  videos: 200 * 1024 * 1024,
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

// Rate limiting: simple in-memory tracker (per isolate)
const uploadTracker = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30; // max uploads per window
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = uploadTracker.get(userId);
  if (!entry || now > entry.resetAt) {
    uploadTracker.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Allowed origins for CORS
const ALLOWED_ORIGINS_LIST = [
  'https://calm-connect-05.lovable.app',
  'https://id-preview--14bf9f2a-b211-4bff-8f3c-1cd3d8a0a907.lovable.app',
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const isAllowed = ALLOWED_ORIGINS_LIST.includes(origin) 
    || origin.endsWith('.lovable.app') 
    || origin.endsWith('.lovableproject.com');
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS_LIST[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}

// ─── Validate file extension matches MIME ───
const MIME_EXT_MAP: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
  "video/quicktime": ["mov"],
  "audio/webm": ["webm"],
  "audio/ogg": ["ogg"],
  "audio/mp4": ["m4a"],
  "audio/mpeg": ["mp3"],
  "application/pdf": ["pdf"],
};

function validateMimeExtension(mime: string, filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const allowed = MIME_EXT_MAP[mime];
  if (!allowed) return false;
  return allowed.includes(ext);
}

// ─── Path traversal protection ───
function sanitizePath(input: string): string {
  return input
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9\-_/.]/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\//, "");
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only allow POST and DELETE
  if (req.method !== "POST" && req.method !== "DELETE") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ─── Auth check ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or invalid authorization header");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    const userId = claimsData?.claims?.sub as string | undefined;
    if (claimsError || !userId) throw new Error("Not authenticated");

    // ─── Rate limit ───
    if (!checkRateLimit(userId)) {
      return new Response(JSON.stringify({ error: "Trop de requêtes. Réessayez dans un moment." }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fetch user profile for folder structure ───
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("name")
      .eq("user_id", userId)
      .single();

    const rawName = profile?.name || "user";
    const sanitizedName = rawName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      || "user";
    const userFolder = `${sanitizedName}-${userId.substring(0, 8)}`;

    // ─── R2 config ───
    const accountId = Deno.env.get("R2_ACCOUNT_ID")?.trim() ?? "";
    let accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID")?.trim() ?? "";
    let secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY")?.trim() ?? "";
    const bucketName = Deno.env.get("R2_BUCKET_NAME")?.trim() ?? "";
    const publicUrl = Deno.env.get("R2_PUBLIC_URL")?.trim() ?? "";

    if (accessKeyId.length === 64 && secretAccessKey.length === 32) {
      [accessKeyId, secretAccessKey] = [secretAccessKey, accessKeyId];
    }

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
      throw new Error("R2 configuration incomplete");
    }

    const r2Region = Deno.env.get("R2_REGION")?.trim() || "";
    const regionPrefix = r2Region ? `${r2Region}.` : "";
    const endpoint = `https://${accountId}.${regionPrefix}r2.cloudflarestorage.com`;
    const host = `${accountId}.${regionPrefix}r2.cloudflarestorage.com`;

    // ═══════ DELETE ═══════
    if (req.method === "DELETE") {
      const { path } = await req.json();
      if (!path || typeof path !== "string") throw new Error("No path provided");

      const cleanPath = sanitizePath(path);

      // Security: strict ownership check — path MUST start with user's folder
      if (!cleanPath.startsWith(`${userFolder}/`)) {
        return new Response(JSON.stringify({ error: "Unauthorized: can only delete own files" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const url = `${endpoint}/${bucketName}/${cleanPath}`;
      const now = new Date();
      const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const shortDate = dateStamp.substring(0, 8);
      const credentialScope = `${shortDate}/auto/s3/aws4_request`;

      const emptyHash = await sha256Hex(new Uint8Array(0));
      const headers: Record<string, string> = {
        host,
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": dateStamp,
      };

      const sig = await sign("DELETE", `/${bucketName}/${cleanPath}`, headers, emptyHash, dateStamp, shortDate, credentialScope, accessKeyId, secretAccessKey);

      await fetch(url, { method: "DELETE", headers: { ...headers, Authorization: sig } });

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══════ POST (upload) ═══════
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const folder = (formData.get("folder") as string) || "uploads";

    if (!file) throw new Error("No file provided");

    // ─── Validate folder name ───
    const cleanFolder = folder.replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!cleanFolder) throw new Error("Invalid folder name");

    // ─── Validate MIME type (strip codec params like "video/webm;codecs=vp9,opus") ───
    const baseMime = file.type.split(";")[0].trim();
    const allowedMimes = ALLOWED_MIME_TYPES[cleanFolder] || ALLOWED_MIME_TYPES["uploads"];
    if (!allowedMimes.includes(baseMime)) {
      return new Response(JSON.stringify({
        error: `Type de fichier non autorisé: ${file.type}. Types acceptés: ${allowedMimes.join(", ")}`,
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Validate extension matches MIME ───
    if (!validateMimeExtension(baseMime, file.name)) {
      return new Response(JSON.stringify({
        error: "L'extension du fichier ne correspond pas à son type MIME",
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Validate file size ───
    const maxSize = FOLDER_MAX_SIZES[cleanFolder] || MAX_FILE_SIZE;
    if (file.size > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      return new Response(JSON.stringify({
        error: `Fichier trop volumineux. Maximum: ${maxMB} Mo`,
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (file.size === 0) {
      return new Response(JSON.stringify({ error: "Fichier vide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Build secure file path ───
    const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
    const safeExt = ext.replace(/[^a-z0-9]/g, "").substring(0, 5);
    const fileName = `${userFolder}/${cleanFolder}/${Date.now()}.${safeExt}`;

    const url = `${endpoint}/${bucketName}/${fileName}`;
    const fileBuffer = await file.arrayBuffer();

    // ─── Validate magic bytes for images ───
    if (file.type.startsWith("image/")) {
      const header = new Uint8Array(fileBuffer.slice(0, 12));
      if (!validateImageMagicBytes(header, file.type)) {
        // Fallback: accept if magic bytes match ANY known image format
        const isAnyImage = isKnownImageMagicBytes(header);
        if (!isAnyImage) {
          return new Response(JSON.stringify({
            error: "Le contenu du fichier ne correspond pas au type déclaré",
          }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const shortDate = dateStamp.substring(0, 8);
    const credentialScope = `${shortDate}/auto/s3/aws4_request`;

    const payloadHash = await sha256Hex(new Uint8Array(fileBuffer));

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": dateStamp,
      "content-type": file.type || "application/octet-stream",
      // Add cache control for immutable assets
      "cache-control": "public, max-age=31536000, immutable",
    };

    const authorization = await sign("PUT", `/${bucketName}/${fileName}`, headers, payloadHash, dateStamp, shortDate, credentialScope, accessKeyId, secretAccessKey);

    const r2Response = await fetch(url, {
      method: "PUT",
      headers: { ...headers, Authorization: authorization },
      body: fileBuffer,
    });

    if (!r2Response.ok) {
      const errorText = await r2Response.text();
      console.error("R2 upload error:", errorText);
      throw new Error(`R2 upload failed: ${r2Response.status}`);
    }

    const fileUrl = `${publicUrl.replace(/\/$/, "")}/${fileName}`;

    return new Response(
      JSON.stringify({ url: fileUrl, path: fileName }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("r2-upload error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});

// ─── Image magic bytes validation ───
function validateImageMagicBytes(header: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") {
    return header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
  }
  if (mime === "image/png") {
    return header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
  }
  if (mime === "image/gif") {
    return header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46;
  }
  if (mime === "image/webp") {
    return header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46;
  }
  return true; // Unknown image format, allow
}

function isKnownImageMagicBytes(header: Uint8Array): boolean {
  // JPEG
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return true;
  // PNG
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return true;
  // GIF
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return true;
  // WEBP (RIFF)
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) return true;
  // BMP
  if (header[0] === 0x42 && header[1] === 0x4D) return true;
  // HEIC/HEIF (ftyp box)
  if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) return true;
  return false;
}

// ─── AWS Signature V4 helpers ───

async function sign(
  method: string, path: string, headers: Record<string, string>,
  payloadHash: string, dateStamp: string, shortDate: string,
  credentialScope: string, accessKeyId: string, secretAccessKey: string
): Promise<string> {
  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", dateStamp, credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretAccessKey}`), shortDate);
  const kRegion = await hmacSha256(kDate, "auto");
  const kService = await hmacSha256(kRegion, "s3");
  const signingKey = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

async function hmacSha256(key: Uint8Array | ArrayBuffer, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

function toHex(arr: Uint8Array): string {
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
