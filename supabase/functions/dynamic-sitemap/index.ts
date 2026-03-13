import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const SITE_URL = "https://forsure.fans";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const type = url.searchParams.get("type") || "index";

    if (type === "index") {
      // Sitemap index
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE_URL}/api/sitemap?type=profiles</loc></sitemap>
  <sitemap><loc>${SITE_URL}/api/sitemap?type=posts</loc></sitemap>
  <sitemap><loc>${SITE_URL}/api/sitemap?type=static</loc></sitemap>
</sitemapindex>`;
      return new Response(xml, {
        headers: { ...corsHeaders, "Content-Type": "application/xml", "Cache-Control": "public, s-maxage=3600" },
      });
    }

    if (type === "profiles") {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, name, updated_at, profile_type")
        .eq("profile_type", "public")
        .order("updated_at", { ascending: false })
        .limit(50000);

      const urls = (profiles || []).map((p: any) => `
  <url>
    <loc>${SITE_URL}/profile/${p.user_id}</loc>
    <lastmod>${new Date(p.updated_at).toISOString().split("T")[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`).join("");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`;
      return new Response(xml, {
        headers: { ...corsHeaders, "Content-Type": "application/xml", "Cache-Control": "public, s-maxage=3600" },
      });
    }

    if (type === "posts") {
      const { data: posts } = await supabase
        .from("posts")
        .select("id, created_at")
        .order("created_at", { ascending: false })
        .limit(50000);

      const urls = (posts || []).map((p: any) => `
  <url>
    <loc>${SITE_URL}/post/${p.id}</loc>
    <lastmod>${new Date(p.created_at).toISOString().split("T")[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`).join("");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`;
      return new Response(xml, {
        headers: { ...corsHeaders, "Content-Type": "application/xml", "Cache-Control": "public, s-maxage=3600" },
      });
    }

    if (type === "static") {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>${SITE_URL}/login</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>
  <url><loc>${SITE_URL}/signup</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
  <url><loc>${SITE_URL}/legal</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
  <url><loc>${SITE_URL}/privacy</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
</urlset>`;
      return new Response(xml, {
        headers: { ...corsHeaders, "Content-Type": "application/xml", "Cache-Control": "public, s-maxage=86400" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
