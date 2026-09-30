import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, getClientIP } from "../_shared/rate-limit.ts";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_DIMENSION = 4096;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

async function readBodyWithLimit(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel("image too large");
      throw new Error("IMAGE_TOO_LARGE");
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Image optimization edge function.
 * Accepts an image URL and returns an optimized version with:
 * - Resize to specified dimensions
 * - WebP conversion
 * - Quality adjustment
 * 
 * Usage: /image-optimize?url=...&w=400&h=400&q=80
 */
Deno.serve(async (req) => {
  const headers = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json", Allow: "GET" },
    });
  }

  const ip = getClientIP(req);
  const rateLimited = await checkRateLimit(`img-opt:${ip}`, 60, 60, headers);
  if (rateLimited) return rateLimited;

  try {
    const url = new URL(req.url);
    const imageUrl = url.searchParams.get("url");
    const widthRaw = url.searchParams.get("w");
    const heightRaw = url.searchParams.get("h");
    const qualityRaw = url.searchParams.get("q") ?? "80";
    const width = widthRaw === null ? undefined : Number(widthRaw);
    const height = heightRaw === null ? undefined : Number(heightRaw);
    const quality = Number(qualityRaw);

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: "Missing 'url' parameter" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    if (
      (width !== undefined && (!Number.isInteger(width) || width < 1 || width > MAX_DIMENSION)) ||
      (height !== undefined && (!Number.isInteger(height) || height < 1 || height > MAX_DIMENSION)) ||
      !Number.isInteger(quality) || quality < 1 || quality > 100
    ) {
      return new Response(
        JSON.stringify({ error: "Invalid image dimensions or quality" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Only our exact Supabase/R2 hosts are accepted. Wildcard R2 hosts would
    // allow an attacker-controlled bucket to turn this endpoint into a proxy.
    let parsedUrl: URL;
    try { parsedUrl = new URL(imageUrl); } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
    }
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      parsedUrl.port !== ""
    ) {
      return new Response(JSON.stringify({ error: "Only https URLs allowed" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
    }
    const host = parsedUrl.hostname.toLowerCase();
    const supabaseHost = (() => {
      try { return new URL(Deno.env.get("SUPABASE_URL") || "").hostname.toLowerCase(); }
      catch { return ""; }
    })();
    const r2PublicHost = (() => {
      try { return new URL(Deno.env.get("R2_PUBLIC_URL") || "").hostname.toLowerCase(); }
      catch { return ""; }
    })();
    // Supabase signed/private object URLs must never pass through this endpoint:
    // the response is intentionally cached as public and immutable. Only the
    // explicit public-object route is safe to proxy. R2_PUBLIC_URL already
    // designates the application's public media origin.
    const isPublicSupabaseObject =
      Boolean(supabaseHost) &&
      host === supabaseHost &&
      parsedUrl.pathname.startsWith("/storage/v1/object/public/");
    const isPublicR2Object = Boolean(r2PublicHost) && host === r2PublicHost;
    const isTrusted = isPublicSupabaseObject || isPublicR2Object;
    if (!isTrusted) {
      return new Response(
        JSON.stringify({ error: "Untrusted image source" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    // Fetch the original image
    const imageResponse = await fetch(imageUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!imageResponse.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch image" }),
        { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const contentType = (imageResponse.headers.get("Content-Type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const contentLength = Number(imageResponse.headers.get("Content-Length") || "0");
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return new Response(JSON.stringify({ error: "Unsupported image format" }), {
        status: 415,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      return new Response(JSON.stringify({ error: "Image too large" }), {
        status: 413,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let imageData: Uint8Array;
    try {
      imageData = await readBodyWithLimit(imageResponse);
    } catch (error) {
      if (error instanceof Error && error.message === "IMAGE_TOO_LARGE") {
        return new Response(JSON.stringify({ error: "Image too large" }), {
          status: 413,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      throw error;
    }

    // For now, proxy the image with proper caching headers
    // In production, integrate with a real image processing service (Sharp, Cloudflare Image Resizing, etc.)
    const responseHeaders: Record<string, string> = {
      ...headers,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "CDN-Cache-Control": "public, max-age=31536000",
      "Vary": "Accept",
    };

    // Add resize hint headers for CDN (Cloudflare Polish/Image Resizing)
    if (width) responseHeaders["X-Resize-Width"] = String(width);
    if (height) responseHeaders["X-Resize-Height"] = String(height);

    return new Response(imageData as unknown as BodyInit, { headers: responseHeaders });
  } catch (err) {
    console.error(
      "image-optimize failed",
      err instanceof Error ? err.message : "unknown error",
    );
    return new Response(
      JSON.stringify({ error: "Image optimization failed" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }
});
