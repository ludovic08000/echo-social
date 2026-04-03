import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";

// Whitelist of allowed Stripe price IDs
const ALLOWED_PRICE_IDS = new Set<string>();
// We allow any valid Stripe price ID format but verify it exists server-side

serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  // DDoS protection — critical tier for payments
  const ddosBlock = await ddosShield(req, cors, "critical", "create-checkout");
  if (ddosBlock) return ddosBlock;

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("User not authenticated");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser();
    if (authErr || !user?.email) throw new Error("User not authenticated or email not available");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const { priceId } = await req.json();
    if (!priceId || typeof priceId !== "string") throw new Error("Price ID required");

    // Validate price ID format (Stripe price IDs start with "price_")
    if (!priceId.startsWith("price_")) throw new Error("Invalid price ID format");

    // Verify price exists in Stripe (server-side validation)
    const price = await stripe.prices.retrieve(priceId);
    if (!price || !price.active) throw new Error("Prix invalide ou inactif");

    // Check if Stripe customer exists
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;

      const subs = await stripe.subscriptions.list({
        customer: customerId,
        price: priceId,
        status: "active",
        limit: 1,
      });
      if (subs.data.length > 0) {
        throw new Error("Vous avez déjà un abonnement actif");
      }
    }

    const origin = req.headers.get("origin") || "https://calm-connect-05.lovable.app";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      phone_number_collection: { enabled: false },
      success_url: `${origin}/creator-upgrade?success=true`,
      cancel_url: `${origin}/creator-upgrade?canceled=true`,
      metadata: { user_id: user.id },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = (error as Error).message;
    const isValidation = ["Price ID", "User not authenticated", "Vous avez déjà", "Invalid price", "Prix invalide"].some(s => msg.includes(s));
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...cors, "Content-Type": "application/json" },
      status: isValidation ? 400 : 500,
    });
  }
});
