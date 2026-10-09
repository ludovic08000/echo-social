// Abonnement d'un fan à un créateur : session Stripe récurrente, commission ForSure 25 %.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Commission ForSure de 25 % sur les abonnements des fans : le créateur garde 75 %.
const COMMISSION_RATE = 0.25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Méthode non autorisée" }, 405, cors);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Non connecté");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: authErr } = await userClient.auth.getUser();
    const user = userData.user;
    if (authErr || !user?.email) throw new Error("Non connecté");

    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const parsed = await req.json().catch(() => null);
    const creatorId = typeof parsed?.creator_id === "string" ? parsed.creator_id : "";
    if (!UUID_RE.test(creatorId)) throw new Error("Créateur non spécifié");
    if (creatorId === user.id) throw new Error("Vous ne pouvez pas vous abonner à vous-même");

    const { data: club, error: clubErr } = await supabase
      .from("fan_clubs")
      .select("is_enabled, monthly_price_cents, stripe_price_id")
      .eq("creator_id", creatorId)
      .maybeSingle();
    if (clubErr) throw new Error(`Lecture du club impossible : ${clubErr.message}`);
    if (!club?.is_enabled || !club.stripe_price_id) {
      return jsonResponse({ error: "Ce créateur n'a pas de club d'abonnés ouvert." }, 404, cors);
    }

    const { data: creatorBadge, error: badgeErr } = await supabase.rpc("has_active_creator_badge", {
      p_user_id: creatorId,
    });
    if (badgeErr) throw new Error(`Vérification du badge impossible : ${badgeErr.message}`);
    if (!creatorBadge) {
      return jsonResponse({ error: "Le badge Créateur de ce compte n'est plus actif." }, 403, cors);
    }

    const { data: existing, error: existingErr } = await supabase
      .from("fan_subscriptions")
      .select("status")
      .eq("creator_id", creatorId)
      .eq("fan_id", user.id)
      .maybeSingle();
    if (existingErr) throw new Error(`Vérification impossible : ${existingErr.message}`);
    if (existing && ["active", "pending", "past_due"].includes(existing.status)) {
      return jsonResponse({ error: "Vous êtes déjà abonné à ce créateur." }, 409, cors);
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const price = await stripe.prices.retrieve(club.stripe_price_id);
    if (!price?.active) return jsonResponse({ error: "Abonnement indisponible pour le moment." }, 400, cors);
    const amountCents = price.unit_amount ?? club.monthly_price_cents;

    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      const already = await stripe.subscriptions.list({
        customer: customerId,
        price: club.stripe_price_id,
        status: "active",
        limit: 1,
      });
      if (already.data.length > 0) {
        return jsonResponse({ error: "Vous êtes déjà abonné à ce créateur." }, 409, cors);
      }
    }

    const commissionCents = Math.round(amountCents * COMMISSION_RATE);
    const origin = req.headers.get("origin") || "https://forsure.fans";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [{ price: club.stripe_price_id, quantity: 1 }],
      mode: "subscription",
      phone_number_collection: { enabled: false },
      subscription_data: {
        metadata: {
          type: "fan_subscription",
          creator_id: creatorId,
          fan_id: user.id,
        },
      },
      metadata: {
        type: "fan_subscription",
        creator_id: creatorId,
        fan_id: user.id,
      },
      success_url: `${origin}/profile/${creatorId}?sub=success`,
      cancel_url: `${origin}/profile/${creatorId}?sub=canceled`,
    });

    const { error: insertErr } = await supabase.from("fan_subscriptions").upsert(
      {
        creator_id: creatorId,
        fan_id: user.id,
        status: "pending",
        amount_cents: amountCents,
        commission_cents: commissionCents,
        creator_payout_cents: amountCents - commissionCents,
        commission_rate: COMMISSION_RATE,
        stripe_price_id: club.stripe_price_id,
        stripe_customer_id: session.customer ?? customerId ?? null,
        stripe_subscription_id: null,
      },
      { onConflict: "creator_id,fan_id" }
    );
    if (insertErr) throw new Error(`Enregistrement de l'abonnement impossible : ${insertErr.message}`);

    return jsonResponse({ url: session.url }, 200, cors);
  } catch (error) {
    const msg = (error as Error).message;
    const isValidation = ["Non connecté", "Créateur non spécifié", "vous-même", "déjà abonné"].some((s) =>
      msg.toLowerCase().includes(s.toLowerCase())
    );
    return jsonResponse({ error: msg }, isValidation ? 400 : 500, cors);
  }
});
