import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rate-limit.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rateLimited = await checkRateLimit(`contact-match:${user.id}`, 20, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const { contacts } = await req.json();

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return new Response(JSON.stringify({ matches: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Extract all phone numbers and emails
    const allPhones: string[] = [];
    const allEmails: string[] = [];

    for (const c of contacts) {
      if (c.phoneNumbers) allPhones.push(...c.phoneNumbers);
      if (c.emails) allEmails.push(...c.emails);
    }

    // Limit to 500 phones and 500 emails
    const phones = allPhones.slice(0, 500);
    const emails = allEmails.slice(0, 500).map((e: string) => e.toLowerCase().trim());

    // Match by phone using the existing DB function
    let phoneMatches: any[] = [];
    if (phones.length > 0) {
      const { data } = await supabase.rpc("match_contacts_by_phone", {
        p_phone_numbers: phones,
      });
      phoneMatches = data || [];
    }

    // Match by email
    let emailMatches: any[] = [];
    if (emails.length > 0) {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, name, avatar_url")
        .neq("user_id", user.id);

      // We need to match emails against auth users - but we can't access auth.users
      // So we'll just return phone matches for now, which is the primary use case
    }

    // Deduplicate by user_id
    const seen = new Set<string>();
    const matches = phoneMatches.filter((m: any) => {
      if (seen.has(m.user_id)) return false;
      seen.add(m.user_id);
      return true;
    });

    return new Response(JSON.stringify({ matches }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("contact-match error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erreur interne" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
