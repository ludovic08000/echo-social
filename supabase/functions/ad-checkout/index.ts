import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );

  try {
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("Non authentifié");

    const { campaign_id, amount, campaign_title } = await req.json();
    if (!campaign_id || !amount) throw new Error("Données manquantes");

    // Validate amount server-side
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 1 || numAmount > 100000) {
      throw new Error("Montant invalide (min 1€, max 100 000€)");
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Find or create Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    }

    const origin = req.headers.get("origin") || "https://calm-connect-05.lovable.app";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `Campagne pub: ${campaign_title || "ForSure Ads"}`,
              description: `Budget publicitaire ForSure Ads`,
            },
            unit_amount: Math.round(numAmount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${origin}/ads?payment=success&campaign_id=${campaign_id}`,
      cancel_url: `${origin}/ads?payment=canceled`,
      metadata: {
        campaign_id,
        user_id: user.id,
        type: "ad_campaign",
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isValidation = ["Non authentifié", "Données manquantes"].some(s => msg.includes(s));
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: isValidation ? 400 : 500,
    });
  }
});
