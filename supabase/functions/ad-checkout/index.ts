import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.0";
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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("Non authentifié");

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: profile, error: profileError } = await serviceClient
      .from("profiles")
      .select("is_creator")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profileError) throw new Error("Vérification du compte créateur indisponible");
    if (profile?.is_creator !== true) {
      return new Response(JSON.stringify({ error: "Accès réservé aux comptes créateur", code: "CREATOR_ACCOUNT_REQUIRED" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 403,
      });
    }

    const { campaign_id } = await req.json();
    if (!campaign_id) throw new Error("Données manquantes");

    const { data: campaign, error: campaignError } = await serviceClient
      .from("ad_campaigns")
      .select("id, advertiser_id, title, budget, status")
      .eq("id", campaign_id)
      .eq("advertiser_id", user.id)
      .maybeSingle();
    if (campaignError) throw new Error("Campagne indisponible");
    if (!campaign) {
      return new Response(JSON.stringify({ error: "Campagne introuvable ou non autorisée" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 404,
      });
    }
    if (campaign.status !== "pending_payment") {
      return new Response(JSON.stringify({ error: "Cette campagne n'attend pas de paiement" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 409,
      });
    }

    // The amount and title are loaded from the owned campaign, never trusted from the browser.
    const numAmount = Number(campaign.budget);
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

    const configuredOrigin = Deno.env.get("PUBLIC_SITE_URL") || "https://forsure.fans";
    const requestOrigin = req.headers.get("origin");
    const isLocalOrigin = requestOrigin ? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin) : false;
    const origin = requestOrigin === configuredOrigin || isLocalOrigin ? requestOrigin! : configuredOrigin;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `Campagne pub: ${campaign.title || "ForSure Ads"}`,
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
    }, {
      idempotencyKey: `forsure-ad-campaign-${campaign_id}`,
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
