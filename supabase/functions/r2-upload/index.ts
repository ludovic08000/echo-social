import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Not authenticated");

    // Fetch user profile name for folder structure
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("name")
      .eq("user_id", user.id)
      .single();

    // Sanitize name for folder: lowercase, remove accents/special chars, replace spaces with hyphens
    const rawName = profile?.name || "user";
    const sanitizedName = rawName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      || "user";
    const userFolder = `${sanitizedName}-${user.id.substring(0, 8)}`;

    // R2 config
    const accountId = Deno.env.get("R2_ACCOUNT_ID")?.trim() ?? "";
    let accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID")?.trim() ?? "";
    let secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY")?.trim() ?? "";
    const bucketName = Deno.env.get("R2_BUCKET_NAME")?.trim() ?? "";
    const publicUrl = Deno.env.get("R2_PUBLIC_URL")?.trim() ?? "";

    // Auto-heal common misconfiguration: swapped access key / secret key
    if (accessKeyId.length === 64 && secretAccessKey.length === 32) {
      [accessKeyId, secretAccessKey] = [secretAccessKey, accessKeyId];
      console.warn("R2 credentials appeared swapped; using corrected order at runtime");
    }

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
      throw new Error("R2 configuration incomplete");
    }

    // Support regional R2 endpoints (e.g. eu.r2.cloudflarestorage.com)
    const r2Region = Deno.env.get("R2_REGION")?.trim() || "";
    const regionPrefix = r2Region ? `${r2Region}.` : "";
    const endpoint = `https://${accountId}.${regionPrefix}r2.cloudflarestorage.com`;

    // --- DELETE ---
    if (req.method === "DELETE") {
      const { path } = await req.json();
      if (!path) throw new Error("No path provided");

      // Security: only allow deleting own files (check both old and new path formats)
      if (!path.includes(`/${user.id}/`) && !path.includes(`${userFolder}/`)) {
        throw new Error("Unauthorized: can only delete own files");
      }

      const url = `${endpoint}/${bucketName}/${path}`;
      const now = new Date();
      const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const shortDate = dateStamp.substring(0, 8);
      const region = "auto";
      const credentialScope = `${shortDate}/${region}/s3/aws4_request`;

      const emptyHash = await sha256Hex(new Uint8Array(0));
      const host = `${accountId}.${regionPrefix}r2.cloudflarestorage.com`;
      const headers: Record<string, string> = {
        host,
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": dateStamp,
      };

      const sig = await sign("DELETE", `/${bucketName}/${path}`, headers, emptyHash, dateStamp, shortDate, credentialScope, accessKeyId, secretAccessKey);

      await fetch(url, {
        method: "DELETE",
        headers: { ...headers, Authorization: sig },
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- PUT (upload) ---
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const folder = (formData.get("folder") as string) || "uploads";

    if (!file) throw new Error("No file provided");

    const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
    // Structure: {userFolder}/{category}/{timestamp}.{ext}
    // e.g. ludovic-98c32ea4/post-images/1772970005315.jpg
    const fileName = `${userFolder}/${folder}/${Date.now()}.${ext}`;

    const url = `${endpoint}/${bucketName}/${fileName}`;
    const fileBuffer = await file.arrayBuffer();

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const shortDate = dateStamp.substring(0, 8);
    const region = "auto";
    const credentialScope = `${shortDate}/${region}/s3/aws4_request`;

    const payloadHash = await sha256Hex(new Uint8Array(fileBuffer));

    const host = `${accountId}.${regionPrefix}r2.cloudflarestorage.com`;
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": dateStamp,
      "content-type": file.type || "application/octet-stream",
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
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// --- AWS Signature V4 helpers ---

async function sign(
  method: string,
  path: string,
  headers: Record<string, string>,
  payloadHash: string,
  dateStamp: string,
  shortDate: string,
  credentialScope: string,
  accessKeyId: string,
  secretAccessKey: string
): Promise<string> {
  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

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

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(hash));
}

async function hmacSha256(key: Uint8Array | ArrayBuffer, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function toHex(arr: Uint8Array): string {
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
