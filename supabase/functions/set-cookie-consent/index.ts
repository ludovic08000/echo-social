import { getCorsHeaders } from "../_shared/cors.ts";

/**
 * Edge function to set a secure HttpOnly cookie for cookie consent.
 * This cookie cannot be read or tampered with by JavaScript (XSS-proof).
 */
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { consent } = body;

    // Strict validation: only "accepted" or "declined"
    if (consent !== "accepted" && consent !== "declined") {
      return new Response(
        JSON.stringify({ error: "Invalid consent value. Must be 'accepted' or 'declined'." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cookie expires in 13 months (CNIL recommendation)
    const maxAge = 13 * 30 * 24 * 60 * 60; // ~13 months in seconds
    const expires = new Date(Date.now() + maxAge * 1000).toUTCString();

    // Build the secure cookie
    const cookieValue = [
      `forsure_consent=${consent}`,
      `Path=/`,
      `Expires=${expires}`,
      `Max-Age=${maxAge}`,
      `HttpOnly`,
      `Secure`,
      `SameSite=Strict`,
    ].join("; ");

    return new Response(
      JSON.stringify({ ok: true, consent }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Set-Cookie": cookieValue,
        },
      }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
