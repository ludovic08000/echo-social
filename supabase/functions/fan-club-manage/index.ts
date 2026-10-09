// Club d'abonnés : le créateur active son club, fixe le prix mensuel et la description.
// Le prix et les identifiants Stripe ne sont écrits qu'ici (service_role), jamais depuis le navigateur.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

const MIN_PRICE_CENTS = 199;
const MAX_PRICE_CENTS = 4999;

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
    if (authErr || !user) throw new Error("Non connecté");

    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    // Le badge Créateur (4,99 €/mois) est la seule porte d'entrée vers les revenus.
    const { data: badgeOk, error: badgeErr } = await supabase.rpc("has_active_creator_badge", {
      p_user_id: user.id,
    });
    if (badgeErr) throw new Error(`Vérification du badge impossible : ${badgeErr.message}`);
    if (!badgeOk) {
      return jsonResponse(
        { error: "BADGE_REQUIS : le badge Créateur à 4,99 €/mois est nécessaire pour ouvrir un club d'abonnés." },
        403,
        cors
      );
    }

    const parsed = await req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object") throw new Error("Requête invalide");

    const isEnabled = parsed.is_enabled === true;
    const rawPrice = parsed.monthly_price_cents;
    const rawDescription = typeof parsed.description === "string" ? parsed.description.trim() : "";

    if (rawPrice !== undefined && rawPrice !== null) {
      if (typeof rawPrice !== "number" || !Number.isInteger(rawPrice) || rawPrice < MIN_PRICE_CENTS || rawPrice > MAX_PRICE_CENTS) {
        throw new Error(`Prix mensuel invalide : entre ${MIN_PRICE_CENTS / 100} € et ${MAX_PRICE_CENTS / 100} €`);
      }
    }
    if (rawDescription.length > 500) throw new Error("Description trop longue (500 caractères maximum)");

    const { data: club, error: clubLookupErr } = await supabase
      .from("fan_clubs")
      .select("id, stripe_product_id, stripe_price_id, monthly_price_cents")
      .eq("creator_id", user.id)
      .maybeSingle();
    if (clubLookupErr) throw new Error(`Lecture du club impossible : ${clubLookupErr.message}`);

    const wantedPrice = typeof rawPrice === "number" ? rawPrice : club?.monthly_price_cents ?? 299;

    let productId = club?.stripe_product_id ?? null;
    let priceId = club?.stripe_price_id ?? null;

    if (isEnabled || wantedPrice !== club?.monthly_price_cents || !priceId) {
      const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
        apiVersion: "2025-08-27.basil",
      });

      const { data: profile } = await supabase
        .from("profiles")
        .select("name, username")
        .eq("user_id", user.id)
        .maybeSingle();
      const creatorLabel = profile?.name || profile?.username || user.id;

      if (!productId) {
        const product = await stripe.products.create({
          name: `Club de abonnés de ${creatorLabel}`,
          description: "Abonnement mensuel au club privé d'un créateur ForSure.",
          metadata: { creator_id: user.id, app: "forsure", kind: "fan_club" },
        });
        productId = product.id;
      }

      const needsNewPrice = !priceId || club?.monthly_price_cents !== wantedPrice;
      if (needsNewPrice) {
        const price = await stripe.prices.create({
          product: productId,
          currency: "eur",
          unit_amount: wantedPrice,
          recurring: { interval: "month" },
          metadata: { creator_id: user.id, kind: "fan_club" },
        });
        priceId = price.id;
      }
    }

    const { error: upsertErr } = await supabase.from("fan_clubs").upsert(
      {
        creator_id: user.id,
        is_enabled: isEnabled,
        monthly_price_cents: wantedPrice,
        description: rawDescription || null,
        stripe_product_id: productId,
        stripe_price_id: priceId,
      },
      { onConflict: "creator_id" }
    );
    if (upsertErr) throw new Error(`Enregistrement du club impossible : ${upsertErr.message}`);

    return jsonResponse(
      {
        is_enabled: isEnabled,
        monthly_price_cents: wantedPrice,
        stripe_price_id: isEnabled ? priceId : null,
      },
      200,
      cors
    );
  } catch (error) {
    const msg = (error as Error).message;
    const isValidation = ["Non connecté", "invalide", "trop longue", "Requête invalide", "Méthode"].some((s) =>
      msg.includes(s)
    );
    return jsonResponse({ error: msg }, isValidation ? 400 : 500, cors);
  }
});
