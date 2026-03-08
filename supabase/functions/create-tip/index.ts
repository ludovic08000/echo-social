import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
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
    if (!user?.email) throw new Error("Non connecté");

    const { amount, creator_id, message } = await req.json();

    if (!amount || amount < 1) throw new Error("Montant minimum : 1€");
    if (!creator_id) throw new Error("Créateur non spécifié");
    // Self-tips allowed for testing

    // Verify creator exists and is a creator
    const { data: creatorProfile } = await supabaseClient
      .from("profiles")
      .select("name, is_creator")
      .eq("user_id", creator_id)
      .single();

    if (!creatorProfile?.is_creator) throw new Error("Cet utilisateur n'est pas créateur");

    const commissionRate = 0.15;
    const commissionAmount = Math.round(amount * commissionRate * 100) / 100;
    const creatorPayout = Math.round((amount - commissionAmount) * 100) / 100;

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Check if Stripe customer exists
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    }

    // Create a one-time payment session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `Tip pour ${creatorProfile.name}`,
              description: message || `Tip de ${amount}€`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.headers.get("origin")}/profile/${creator_id}?tip=success`,
      cancel_url: `${req.headers.get("origin")}/profile/${creator_id}?tip=canceled`,
      metadata: {
        type: "tip",
        tipper_id: user.id,
        creator_id,
        amount: amount.toString(),
        commission_amount: commissionAmount.toString(),
        creator_payout: creatorPayout.toString(),
        message: message || "",
      },
    });

    // Insert tip record as pending
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    await supabaseAdmin.from("tips").insert({
      tipper_id: user.id,
      creator_id,
      amount,
      commission_amount: commissionAmount,
      creator_payout: creatorPayout,
      commission_rate: commissionRate,
      stripe_session_id: session.id,
      status: "pending",
      message: message || null,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const msg = (error as Error).message;
    const isValidation = ["Non connecté", "Montant minimum", "Créateur non spécifié", "n'est pas créateur"].some(s => msg.includes(s));
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: isValidation ? 400 : 500,
    });
  }
});
