import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ddosShield } from "../_shared/ddos-shield.ts";
import { creatorPlanForPrice, creatorPriceId, CREATOR_PLANS, paymentReturnOrigin, type CreatorPlan } from "../_shared/payment-authority.ts";

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

    const { plan } = await req.json();
    if (!plan || !(plan in CREATOR_PLANS)) throw new Error("Invalid creator plan");
    const creatorPlan = plan as CreatorPlan;
    const priceId = creatorPriceId(creatorPlan);
    if (!priceId) throw new Error("CREATOR_PLAN_UNAVAILABLE");

    // Verify price exists in Stripe (server-side validation)
    const price = await stripe.prices.retrieve(priceId);
    if (creatorPlanForPrice(price) !== creatorPlan) throw new Error("Prix invalide ou inactif");

    // Check if Stripe customer exists
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;

      const subs = await stripe.subscriptions.list({ customer: customerId, status: "active", limit: 100 });
      if (subs.data.some((sub) => sub.items.data.some((item) => creatorPlanForPrice(item.price)))) {
        throw new Error("Vous avez déjà un abonnement actif");
      }
    }

    const origin = paymentReturnOrigin(req);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      phone_number_collection: { enabled: false },
      success_url: `${origin}/creator?success=true`,
      cancel_url: `${origin}/creator?canceled=true`,
      client_reference_id: user.id,
      metadata: { type: "creator_subscription", user_id: user.id, plan: creatorPlan },
      subscription_data: { metadata: { type: "creator_subscription", user_id: user.id, plan: creatorPlan } },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = (error as Error).message;
    const isValidation = ["creator plan", "CREATOR_PLAN_UNAVAILABLE", "User not authenticated", "Vous avez déjà", "Prix invalide"].some(s => msg.includes(s));
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...cors, "Content-Type": "application/json" },
      status: isValidation ? 400 : 500,
    });
  }
});
