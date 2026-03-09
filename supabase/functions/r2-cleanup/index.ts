import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * R2 Cleanup – finds orphaned media URLs in the database and deletes them from R2.
 * 
 * Scans all tables/columns that store R2 URLs, checks if the referenced file
 * still has a valid DB row, and deletes orphaned files from R2.
 */

// All table+column combos that may hold R2 URLs
const MEDIA_COLUMNS: { table: string; column: string }[] = [
  { table: "posts", column: "image_url" },
  { table: "profiles", column: "avatar_url" },
  { table: "albums", column: "cover_url" },
  { table: "album_media", column: "media_url" },
  { table: "ad_campaigns", column: "image_url" },
  { table: "ad_campaigns", column: "video_url" },
  { table: "challenges", column: "image_url" },
  { table: "challenge_submissions", column: "image_url" },
  { table: "groups", column: "cover_image_url" },
  { table: "group_posts", column: "image_url" },
  { table: "live_streams", column: "thumbnail_url" },
  { table: "live_streams", column: "recording_url" },
  { table: "messages", column: "image_url" },
  { table: "products", column: "image_url" },
  { table: "stories", column: "media_url" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth: require admin or service role
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("Missing authorization");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify caller is authenticated
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) throw new Error("Not authenticated");

    // Check admin role
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: user.id,
      _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const r2PublicUrl = (Deno.env.get("R2_PUBLIC_URL") || "").replace(/\/$/, "");
    if (!r2PublicUrl) throw new Error("R2_PUBLIC_URL not configured");

    // Step 1: Collect all R2 URLs currently referenced in the DB
    const referencedUrls = new Set<string>();

    for (const { table, column } of MEDIA_COLUMNS) {
      const { data, error } = await supabase
        .from(table)
        .select(column)
        .not(column, "is", null);

      if (error) {
        console.error(`Error scanning ${table}.${column}:`, error.message);
        continue;
      }

      for (const row of data || []) {
        const val = (row as Record<string, string>)[column];
        if (val && typeof val === "string" && val.includes(r2PublicUrl)) {
          referencedUrls.add(val);
        }
      }
    }

    // Step 2: List all objects in R2 bucket
    const accountId = Deno.env.get("R2_ACCOUNT_ID")?.trim() ?? "";
    let accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID")?.trim() ?? "";
    let secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY")?.trim() ?? "";
    const bucketName = Deno.env.get("R2_BUCKET_NAME")?.trim() ?? "";

    if (accessKeyId.length === 64 && secretAccessKey.length === 32) {
      [accessKeyId, secretAccessKey] = [secretAccessKey, accessKeyId];
    }

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
      throw new Error("R2 configuration incomplete");
    }

    const r2Region = Deno.env.get("R2_REGION")?.trim() || "";
    const regionPrefix = r2Region ? `${r2Region}.` : "";
    const endpoint = `https://${accountId}.${regionPrefix}r2.cloudflarestorage.com`;
    const host = `${accountId}.${regionPrefix}r2.cloudflarestorage.com`;

    // List objects (up to 1000)
    const listUrl = `${endpoint}/${bucketName}?list-type=2&max-keys=1000`;
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const shortDate = dateStamp.substring(0, 8);
    const credentialScope = `${shortDate}/auto/s3/aws4_request`;
    const emptyHash = await sha256Hex(new Uint8Array(0));

    const listHeaders: Record<string, string> = {
      host,
      "x-amz-content-sha256": emptyHash,
      "x-amz-date": dateStamp,
    };

    const listAuth = await sign("GET", `/${bucketName}?list-type=2&max-keys=1000`, listHeaders, emptyHash, dateStamp, shortDate, credentialScope, accessKeyId, secretAccessKey);

    const listResponse = await fetch(listUrl, {
      method: "GET",
      headers: { ...listHeaders, Authorization: listAuth },
    });

    if (!listResponse.ok) {
      const err = await listResponse.text();
      throw new Error(`R2 list failed: ${listResponse.status} - ${err}`);
    }

    const xmlText = await listResponse.text();
    
    // Parse keys from XML
    const keys: string[] = [];
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = keyRegex.exec(xmlText)) !== null) {
      keys.push(match[1]);
    }

    // Step 3: Find orphaned files (in R2 but not referenced in DB)
    const orphaned: string[] = [];
    for (const key of keys) {
      const fullUrl = `${r2PublicUrl}/${key}`;
      if (!referencedUrls.has(fullUrl)) {
        orphaned.push(key);
      }
    }

    // Step 4: Delete orphaned files
    let deleted = 0;
    for (const key of orphaned) {
      try {
        const delUrl = `${endpoint}/${bucketName}/${key}`;
        const delNow = new Date();
        const delDateStamp = delNow.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
        const delShortDate = delDateStamp.substring(0, 8);
        const delScope = `${delShortDate}/auto/s3/aws4_request`;

        const delHeaders: Record<string, string> = {
          host,
          "x-amz-content-sha256": emptyHash,
          "x-amz-date": delDateStamp,
        };

        const delAuth = await sign("DELETE", `/${bucketName}/${key}`, delHeaders, emptyHash, delDateStamp, delShortDate, delScope, accessKeyId, secretAccessKey);

        await fetch(delUrl, { method: "DELETE", headers: { ...delHeaders, Authorization: delAuth } });
        deleted++;
      } catch (e) {
        console.error(`Failed to delete ${key}:`, e);
      }
    }

    return new Response(
      JSON.stringify({
        total_files: keys.length,
        referenced: referencedUrls.size,
        orphaned: orphaned.length,
        deleted,
        orphaned_keys: orphaned.slice(0, 50), // show first 50
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("r2-cleanup error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ─── AWS Signature V4 helpers ───
async function sign(
  method: string, path: string, headers: Record<string, string>,
  payloadHash: string, dateStamp: string, shortDate: string,
  credentialScope: string, accessKeyId: string, secretAccessKey: string
): Promise<string> {
  // Split path and query string
  const [pathPart, queryPart] = path.split("?");
  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalRequest = [method, pathPart, queryPart || "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
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
