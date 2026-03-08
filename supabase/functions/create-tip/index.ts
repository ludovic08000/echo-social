import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Rate limiting
const tipTracker = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = tipTracker.get(userId);
  if (!entry || now > entry.resetAt) {
    tipTracker.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 5) return false; // max 5 tips per minute
  entry.count++;
  return true;
}

serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Non connecté");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser();
    if (authErr || !user?.email) throw new Error("Non connecté");

    // Rate limit
    if (!checkRateLimit(user.id)) {
      return new Response(JSON.stringify({ error: "Trop de requêtes" }), {
        status: 429, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { amount, creator_id, message } = await req.json();

    // Server-side validation
    if (!amount || typeof amount !== "number" || amount < 1) throw new Error("Montant minimum : 1€");
    if (amount > 500) throw new Error("Montant maximum : 500€");
    if (!creator_id || typeof creator_id !== "string") throw new Error("Créateur non spécifié");

    const safeMessage = typeof message === "string" ? message.slice(0, 500) : "";

    // Verify creator exists using service role
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: creatorProfile } = await supabaseAdmin
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

    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) customerId = customers.data[0].id;

    const origin = req.headers.get("origin") || "https://calm-connect-05.lovable.app";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: {
            name: `Tip pour ${creatorProfile.name}`,
            description: safeMessage || `Tip de ${amount}€`,
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${origin}/profile/${creator_id}?tip=success`,
      cancel_url: `${origin}/profile/${creator_id}?tip=canceled`,
      metadata: {
        type: "tip",
        tipper_id: user.id,
        creator_id,
        amount: amount.toString(),
        commission_amount: commissionAmount.toString(),
        creator_payout: creatorPayout.toString(),
        message: safeMessage,
      },
    });

    await supabaseAdmin.from("tips").insert({
      tipper_id: user.id,
      creator_id,
      amount,
      commission_amount: commissionAmount,
      creator_payout: creatorPayout,
      commission_rate: commissionRate,
      stripe_session_id: session.id,
      status: "pending",
      message: safeMessage || null,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = (error as Error).message;
    const isValidation = ["Non connecté", "Montant", "Créateur", "n'est pas créateur", "Trop de"].some(s => msg.includes(s));
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...cors, "Content-Type": "application/json" },
      status: isValidation ? 400 : 500,
    });
  }
});
