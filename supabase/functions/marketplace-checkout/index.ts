// marketplace-checkout v2 - fixed is_active column
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { paymentReturnOrigin, settleMarketplacePayment } from "../_shared/payment-authority.ts";
import { createApiTelemetry } from "../_shared/apiTelemetry.ts";

// Commission ForSure de 25 % prélevée sur le vendeur : l'acheteur paie le prix affiché.
const COMMISSION_RATE = 0.25;

function estimateRelayShipping(weightGrams: number): number {
  const base = 4.2;
  const extra =
    weightGrams <= 500 ? 0 :
    weightGrams <= 1000 ? 0.8 :
    weightGrams <= 2000 ? 1.6 :
    weightGrams <= 5000 ? 2.8 : 4.5;
  return Math.round((base + extra) * 100) / 100;
}

async function handleMarketplaceCheckout(req: Request) {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("Non authentifié");
    }

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) throw new Error("Utilisateur non authentifié");

    const userId = userData.user.id;
    const userEmail = userData.user.email;
    if (!userEmail) throw new Error("Email utilisateur requis");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const body = await req.json();
    const { action } = body;

    // ── CREATE MARKETPLACE CHECKOUT ──
    if (action === "create_checkout") {
      const { items, relay } = body;

      if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error("Panier invalide");
      if (new Set(items.map((item: any) => item.product_id)).size !== items.length) throw new Error("Produit dupliqué");

      // Validate items have required fields
      for (const item of items) {
        if (!item.product_id || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
          throw new Error("Données produit invalides");
        }
      }

      // SECURITY: Fetch real prices and data from DB — never trust client prices
      const productIds = items.map((i: any) => i.product_id);
      const { data: dbProducts, error: prodError } = await supabase
        .from("products")
        .select("id, title, price, seller_id, thumbnail_url, weight_grams, stock_quantity, is_active")
        .in("id", productIds);

      console.log(JSON.stringify({ event: 'marketplace_product_lookup',
        outcome: prodError ? 'failure' : 'success', requested_count: productIds.length,
        returned_count: dbProducts?.length ?? 0, error_code: prodError?.code ?? null }));
      if (prodError) throw new Error(`Erreur DB produits: ${prodError.message}`);
      if (!dbProducts?.length) throw new Error(`Produits introuvables pour IDs: ${productIds.join(", ")}`);

      // Verify all products exist and are available
      const verifiedItems = [];
      for (const item of items) {
        const dbProduct = dbProducts.find((p: any) => p.id === item.product_id);
        if (!dbProduct) throw new Error(`Produit ${item.product_id} introuvable`);
        if (!dbProduct.is_active) throw new Error(`Produit "${dbProduct.title}" n'est plus disponible`);
        if (dbProduct.stock_quantity !== null && dbProduct.stock_quantity < item.quantity) {
          throw new Error(`Stock insuffisant pour "${dbProduct.title}"`);
        }
        verifiedItems.push({
          product_id: dbProduct.id,
          title: dbProduct.title,
          price: dbProduct.price, // Server-side price
          quantity: item.quantity,
          seller_id: dbProduct.seller_id,
          thumbnail_url: dbProduct.thumbnail_url,
          weight_grams: dbProduct.weight_grams,
        });
      }

      // Market : le badge Créateur (4,99 €/mois) est obligatoire pour encaisser une vente.
      const sellerIds = [...new Set(verifiedItems.map((item: any) => item.seller_id).filter(Boolean))];
      if (sellerIds.length > 0) {
        const { data: sellerRows, error: sellerErr } = await supabase
          .from("seller_profiles")
          .select("id, user_id")
          .in("id", sellerIds);
        if (sellerErr) throw new Error(`Vérification des vendeurs impossible : ${sellerErr.message}`);
        if ((sellerRows?.length ?? 0) !== sellerIds.length) {
          throw new Error("Un vendeur de ce panier n'a pas de boutique valide.");
        }
        for (const sellerRow of sellerRows ?? []) {
          const { data: badgeOk, error: badgeErr } = await supabase.rpc("has_active_creator_badge", {
            p_user_id: sellerRow.user_id,
          });
          if (badgeErr) throw new Error(`Vérification du badge impossible : ${badgeErr.message}`);
          if (!badgeOk) {
            throw new Error("BADGE_REQUIS : ce vendeur n'a pas le badge Créateur actif.");
          }
        }
      }

      const subtotal = verifiedItems.reduce((sum: number, item: any) => sum + item.price * item.quantity, 0);
      const commission = Math.round(subtotal * COMMISSION_RATE * 100) / 100;

      // Calculate shipping from DB weights
      let totalShipping = 0;
      let totalWeightGrams = 0;
      if (relay?.id) {
        for (const item of verifiedItems) {
          const weight = item.weight_grams || 500;
          totalWeightGrams += weight * item.quantity;
          totalShipping += estimateRelayShipping(weight) * item.quantity;
        }
        totalShipping = Math.round(totalShipping * 100) / 100;
      }

      const total = subtotal + totalShipping;

      // Build line items for Stripe using server-side prices
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = verifiedItems.map((item: any) => ({
        price_data: {
          currency: "eur",
          product_data: {
            name: item.title,
            images: item.thumbnail_url ? [item.thumbnail_url] : [],
          },
          unit_amount: Math.round(item.price * 100),
        },
        quantity: item.quantity,
      }));

      if (totalShipping > 0) {
        lineItems.push({
          price_data: {
            currency: "eur",
            product_data: {
              name: "Livraison Mondial Relay",
              images: [],
            },
            unit_amount: Math.round(totalShipping * 100),
          },
          quantity: 1,
        });
      }

      const origin = paymentReturnOrigin(req);

      // Generate order number
      const orderNumber = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

      // Create order in DB first (pending status)
      const orderData: any = {
        buyer_id: userId,
        order_number: orderNumber,
        subtotal,
        total,
        commission_rate: COMMISSION_RATE,
        commission_amount: commission,
        status: "pending",
      };

      // Add relay point info if provided
      if (relay?.id) {
        orderData.shipping_method = 'mondial_relay';
        orderData.shipping_relay_id = relay.id;
        orderData.shipping_relay_name = relay.name;
        orderData.shipping_relay_address = relay.address;
        orderData.shipping_relay_postcode = relay.postcode;
        orderData.shipping_relay_city = relay.city;
        orderData.shipping_relay_country = relay.country || 'FR';
        orderData.shipping_weight_grams = totalWeightGrams;
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert(orderData)
        .select()
        .single();

      if (orderError) throw new Error(`Erreur création commande: ${orderError.message}`);

      // Create order items using verified server-side data
      for (const item of verifiedItems) {
        const itemSubtotal = item.price * item.quantity;
        const itemCommission = Math.round(itemSubtotal * COMMISSION_RATE * 100) / 100;

        const { error: itemError } = await supabase.from("order_items").insert({
          order_id: order.id,
          product_id: item.product_id,
          seller_id: item.seller_id,
          title: item.title,
          price: item.price,
          quantity: item.quantity,
          subtotal: itemSubtotal,
          commission_amount: itemCommission,
          seller_payout: itemSubtotal - itemCommission,
          status: "pending",
        });
        if (itemError) throw itemError;
      }

      // Find or create Stripe customer
      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
      let customerId: string | undefined;
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      }

      // Create Stripe Checkout session
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        customer_email: customerId ? undefined : userEmail,
        line_items: lineItems,
        mode: "payment",
        client_reference_id: userId,
        payment_intent_data: { metadata: { user_id: userId, order_id: order.id } },
        phone_number_collection: { enabled: false },
        success_url: `${origin}/marketplace?order_success=${order.id}`,
        cancel_url: `${origin}/marketplace?order_canceled=true`,
        metadata: {
          user_id: userId,
          order_id: order.id,
          order_number: orderNumber,
        },
      });

      // Même avant paiement, la commande est liée à une seule session Stripe créée par ce serveur.
      const { error: bindingError } = await supabase.from("orders").update({
        stripe_checkout_session_id: session.id,
        stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id ?? customerId ?? null,
        payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      }).eq("id", order.id).eq("status", "pending");
      if (bindingError) throw bindingError;

      return new Response(JSON.stringify({ url: session.url, orderId: order.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // ── VERIFY PAYMENT ──
    if (action === "verify_payment") {
      const { orderId } = body;
      if (!orderId) throw new Error("orderId requis");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .eq("buyer_id", userId)
        .single();

      if (!order) throw new Error("Commande introuvable");

      const paid = await settleMarketplacePayment(supabase, stripe, order);
      if (paid) return new Response(JSON.stringify({ paid: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

      return new Response(JSON.stringify({ paid: false, status: order.status }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── NEGOTIATION CHECKOUT ──
    if (action === "negotiation_checkout") {
      const { negotiationId, relay } = body;
      if (!negotiationId) throw new Error("negotiationId requis");

      // Fetch negotiation
      const { data: neg, error: negError } = await supabase
        .from("negotiations")
        .select("*, products(id, title, price, seller_id, thumbnail_url, weight_grams, stock_quantity)")
        .eq("id", negotiationId)
        .single();

      if (negError || !neg) throw new Error("Négociation introuvable");
      if (neg.buyer_id !== userId) throw new Error("Vous n'êtes pas l'acheteur de cette négociation");
      if (neg.status !== "accepted") throw new Error("Cette négociation n'est pas acceptée");
      if (neg.order_id) {
        const { data: existing } = await supabase.from("orders").select("*")
          .eq("id",neg.order_id).eq("buyer_id",userId).maybeSingle();
        if(existing?.status==="pending" && existing.stripe_checkout_session_id){
          const checkout=await stripe.checkout.sessions.retrieve(existing.stripe_checkout_session_id);
          if(checkout.status==="open" && checkout.metadata?.order_id===existing.id && checkout.metadata?.user_id===userId){
            return new Response(JSON.stringify({url:checkout.url,orderId:existing.id}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
          }
        }
        throw new Error("NEGOTIATION_CHECKOUT_ALREADY_CREATED");
      }

      const product = neg.products;
      if (!product) throw new Error("Produit introuvable");
      if (product.stock_quantity !== null && product.stock_quantity < 1) throw new Error("Stock insuffisant");

      const agreedPrice = Number(neg.offered_price);
      if (!Number.isFinite(agreedPrice) || agreedPrice <= 0) throw new Error("Prix négocié invalide");
      const commission = Math.round(agreedPrice * COMMISSION_RATE * 100) / 100;

      // Calculate shipping
      let totalShipping = 0;
      let totalWeightGrams = 0;
      if (relay?.id) {
        const weight = product.weight_grams || 500;
        totalWeightGrams = weight;
        totalShipping = estimateRelayShipping(weight);
      }

      const total = agreedPrice + totalShipping;

      const orderNumber = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

      const orderData: any = {
        buyer_id: userId,
        order_number: orderNumber,
        subtotal: agreedPrice,
        total,
        commission_rate: COMMISSION_RATE,
        commission_amount: commission,
        status: "pending",
        notes: `Prix négocié (original: ${product.price}€)`,
      };

      // Add relay point info if provided
      if (relay?.id) {
        orderData.shipping_method = 'mondial_relay';
        orderData.shipping_relay_id = relay.id;
        orderData.shipping_relay_name = relay.name;
        orderData.shipping_relay_address = relay.address;
        orderData.shipping_relay_postcode = relay.postcode;
        orderData.shipping_relay_city = relay.city;
        orderData.shipping_relay_country = relay.country || 'FR';
        orderData.shipping_weight_grams = totalWeightGrams;
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert(orderData)
        .select()
        .single();

      if (orderError) throw new Error(`Erreur création commande: ${orderError.message}`);

      const itemCommission = Math.round(agreedPrice * COMMISSION_RATE * 100) / 100;
      const { error: itemError } = await supabase.from("order_items").insert({
        order_id: order.id,
        product_id: product.id,
        seller_id: product.seller_id,
        title: product.title,
        price: agreedPrice,
        quantity: 1,
        subtotal: agreedPrice,
        commission_amount: itemCommission,
        seller_payout: agreedPrice - itemCommission,
        status: "pending",
      });
      if (itemError) throw itemError;

      const { data: claimedNegotiation, error: negotiationError } = await supabase.from("negotiations")
        .update({ order_id: order.id }).eq("id", negotiationId).eq("status", "accepted")
        .is("order_id",null).select("id").maybeSingle();
      if (negotiationError) throw negotiationError;
      if(!claimedNegotiation)throw new Error("NEGOTIATION_CHECKOUT_ALREADY_CREATED");

      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
      let customerId: string | undefined;
      if (customers.data.length > 0) customerId = customers.data[0].id;

      const origin = paymentReturnOrigin(req);

      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `${product.title} (prix négocié)`,
              images: product.thumbnail_url ? [product.thumbnail_url] : [],
            },
            unit_amount: Math.round(agreedPrice * 100),
          },
          quantity: 1,
        },
      ];

      if (totalShipping > 0) {
        lineItems.push({
          price_data: {
            currency: "eur",
            product_data: { name: "Livraison Mondial Relay", images: [] },
            unit_amount: Math.round(totalShipping * 100),
          },
          quantity: 1,
        });
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        customer_email: customerId ? undefined : userEmail,
        line_items: lineItems,
        mode: "payment",
        client_reference_id: userId,
        payment_intent_data: { metadata: { user_id: userId, order_id: order.id } },
        phone_number_collection: { enabled: false },
        success_url: `${origin}/marketplace?order_success=${order.id}`,
        cancel_url: `${origin}/marketplace?order_canceled=true`,
        metadata: { user_id: userId, order_id: order.id, order_number: orderNumber, negotiation_id: negotiationId },
      });

      const { error: bindingError } = await supabase.from("orders").update({
        stripe_checkout_session_id: session.id,
        stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id ?? customerId ?? null,
        payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      }).eq("id", order.id).eq("status", "pending");
      if (bindingError) throw bindingError;

      return new Response(JSON.stringify({ url: session.url, orderId: order.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // skip_payment action removed for security (allowed any authenticated user
    // to obtain orders for free). Use the Stripe-backed checkout path instead.
    if (action === "skip_payment") {
      return new Response(JSON.stringify({ error: "skip_payment_disabled" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Action invalide" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("marketplace-checkout error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

serve(async (req) => {
  const telemetry = createApiTelemetry(req, 'marketplace');
  let action = 'unknown';
  if (req.method === 'POST') {
    try {
      const candidate = (await req.clone().json())?.action;
      if (typeof candidate === 'string') action = candidate;
    } catch { /* The business handler returns the validation error. */ }
  }
  telemetry.operation(action);
  telemetry.stage('checkout');
  try {
    return telemetry.finish(await handleMarketplaceCheckout(req), { action });
  } catch {
    return telemetry.finish(new Response(JSON.stringify({ error: 'Marketplace service unavailable' }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    }), { action }, 'MARKETPLACE_INTERNAL_ERROR');
  }
});
