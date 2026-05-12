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

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rateLimited = await checkRateLimit(`import-contacts:${user.id}`, 5, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const { access_token, provider } = await req.json();

    if (!access_token || !provider) {
      return new Response(
        JSON.stringify({ error: "access_token et provider requis" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let contacts: { emails: string[]; phones: string[]; name: string }[] = [];

    if (provider === "google") {
      contacts = await fetchGoogleContacts(access_token);
    } else if (provider === "microsoft") {
      contacts = await fetchMicrosoftContacts(access_token);
    } else {
      return new Response(
        JSON.stringify({ error: "Provider non supporté" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Collect all emails and phones
    const allEmails: string[] = [];
    const allPhones: string[] = [];
    const contactMap = new Map<string, string>(); // email/phone -> contact name

    for (const c of contacts) {
      for (const email of c.emails) {
        const normalized = email.toLowerCase().trim();
        allEmails.push(normalized);
        contactMap.set(normalized, c.name);
      }
      for (const phone of c.phones) {
        const normalized = normalizePhone(phone);
        if (normalized.length >= 8) {
          allPhones.push(normalized);
          contactMap.set(normalized, c.name);
        }
      }
    }

    // Match by phone using existing DB function
    let phoneMatches: any[] = [];
    if (allPhones.length > 0) {
      const phoneBatch = allPhones.slice(0, 500);
      const { data } = await supabase.rpc("match_contacts_by_phone", {
        p_phone_numbers: phoneBatch,
      });
      phoneMatches = data || [];
    }

    // Match by email against profiles (via auth email in user_metadata)
    // Since we can't query auth.users, match emails against profiles
    // We'll search for profiles whose name or user_id matches
    let emailMatches: any[] = [];
    if (allEmails.length > 0) {
      // Query profiles and check if any user signed up with matching emails
      // We use a raw approach: get all profiles and check
      // Better: use the service role to check auth.users emails
      // For now, we'll use a simpler approach via phone matches only
      // Email matching would require service role access
    }

    // Deduplicate by user_id
    const seen = new Set<string>();
    const matches = [...phoneMatches, ...emailMatches]
      .filter((m: any) => {
        if (seen.has(m.user_id)) return false;
        seen.add(m.user_id);
        return true;
      })
      .map((m: any) => ({
        ...m,
        contact_name: contactMap.get(m.phone_number) || m.name,
      }));

    return new Response(
      JSON.stringify({
        matches,
        total_contacts: contacts.length,
        total_emails: allEmails.length,
        total_phones: allPhones.length,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    console.error("import-google-contacts error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erreur interne" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

// ---------- Google People API ----------
async function fetchGoogleContacts(
  accessToken: string
): Promise<{ emails: string[]; phones: string[]; name: string }[]> {
  const contacts: { emails: string[]; phones: string[]; name: string }[] = [];
  let nextPageToken: string | undefined;

  do {
    const url = new URL(
      "https://people.googleapis.com/v1/people/me/connections"
    );
    url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers");
    url.searchParams.set("pageSize", "1000");
    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken);
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error("Google People API error:", res.status, errorBody);
      throw new Error(`Google API error ${res.status}: ${errorBody}`);
    }

    const data = await res.json();
    const connections = data.connections || [];

    for (const person of connections) {
      const name =
        person.names?.[0]?.displayName ||
        person.names?.[0]?.givenName ||
        "Sans nom";
      const emails = (person.emailAddresses || []).map(
        (e: any) => e.value || ""
      );
      const phones = (person.phoneNumbers || []).map(
        (p: any) => p.value || ""
      );

      if (emails.length > 0 || phones.length > 0) {
        contacts.push({ name, emails, phones });
      }
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken && contacts.length < 5000);

  return contacts;
}

// ---------- Microsoft Graph API ----------
async function fetchMicrosoftContacts(
  accessToken: string
): Promise<{ emails: string[]; phones: string[]; name: string }[]> {
  const contacts: { emails: string[]; phones: string[]; name: string }[] = [];
  let nextLink: string | undefined =
    "https://graph.microsoft.com/v1.0/me/contacts?$top=500&$select=displayName,emailAddresses,mobilePhone,homePhones,businessPhones";

  do {
    const res = await fetch(nextLink!, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error("Microsoft Graph error:", res.status, errorBody);
      throw new Error(`Microsoft API error ${res.status}: ${errorBody}`);
    }

    const data = await res.json();
    const items = data.value || [];

    for (const contact of items) {
      const name = contact.displayName || "Sans nom";
      const emails = (contact.emailAddresses || []).map(
        (e: any) => e.address || ""
      );
      const phones = [
        contact.mobilePhone,
        ...(contact.homePhones || []),
        ...(contact.businessPhones || []),
      ].filter(Boolean);

      if (emails.length > 0 || phones.length > 0) {
        contacts.push({ name, emails, phones });
      }
    }

    nextLink = data["@odata.nextLink"];
  } while (nextLink && contacts.length < 5000);

  return contacts;
}

// ---------- Helpers ----------
function normalizePhone(phone: string): string {
  let clean = phone.replace(/[\s\-().]/g, "");
  if (clean.startsWith("0") && clean.length === 10) {
    clean = "+33" + clean.slice(1);
  }
  if (!clean.startsWith("+")) {
    clean = "+" + clean;
  }
  return clean;
}
