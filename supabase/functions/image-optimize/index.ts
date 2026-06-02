import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, getClientIP } from "../_shared/rate-limit.ts";

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

  const ip = getClientIP(req);
  const rateLimited = await checkRateLimit(`img-opt:${ip}`, 60, 60, headers);
  if (rateLimited) return rateLimited;

  try {
    const url = new URL(req.url);
    const imageUrl = url.searchParams.get("url");
    const width = parseInt(url.searchParams.get("w") || "0") || undefined;
    const height = parseInt(url.searchParams.get("h") || "0") || undefined;
    const quality = parseInt(url.searchParams.get("q") || "80");

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: "Missing 'url' parameter" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    // Validate URL — exact host or strict suffix match only (no substring SSRF).
    // Allowed: Supabase storage host, Cloudflare R2 public hosts (*.r2.dev),
    // and our configured R2_PUBLIC_URL host.
    let parsedUrl: URL;
    try { parsedUrl = new URL(imageUrl); } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
    }
    if (parsedUrl.protocol !== "https:") {
      return new Response(JSON.stringify({ error: "Only https URLs allowed" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
    }
    const host = parsedUrl.hostname.toLowerCase();
    const r2PublicHost = (() => {
      try { return new URL(Deno.env.get("R2_PUBLIC_URL") || "").hostname.toLowerCase(); }
      catch { return ""; }
    })();
    const isTrusted =
      host === "vkpmoqfzrihcijjochks.supabase.co" ||
      host.endsWith(".supabase.co") && host.startsWith("vkpmoqfzrihcijjochks.") ||
      host.endsWith(".r2.dev") ||
      host.endsWith(".r2.cloudflarestorage.com") ||
      (r2PublicHost && host === r2PublicHost);
    if (!isTrusted) {
      return new Response(
        JSON.stringify({ error: "Untrusted image source" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    // Fetch the original image
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch image" }),
        { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const imageData = await imageResponse.arrayBuffer();

    // For now, proxy the image with proper caching headers
    // In production, integrate with a real image processing service (Sharp, Cloudflare Image Resizing, etc.)
    const responseHeaders: Record<string, string> = {
      ...headers,
      "Content-Type": imageResponse.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "CDN-Cache-Control": "public, max-age=31536000",
      "Vary": "Accept",
    };

    // Add resize hint headers for CDN (Cloudflare Polish/Image Resizing)
    if (width) responseHeaders["X-Resize-Width"] = String(width);
    if (height) responseHeaders["X-Resize-Height"] = String(height);

    return new Response(imageData, { headers: responseHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }
});
