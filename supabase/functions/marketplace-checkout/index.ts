import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const COMMISSION_RATE = 0.05; // 5% buyer fee

function estimateRelayShipping(weightGrams: number, parcels: number): number {
  const basePerParcel = 4.2;
  const weightExtra =
    weightGrams <= 500 ? 0 :
    weightGrams <= 1000 ? 0.8 :
    weightGrams <= 2000 ? 1.6 :
    weightGrams <= 5000 ? 2.8 : 4.5;

  return Math.round((basePerParcel + weightExtra) * parcels * 100) / 100;
}

serve(async (req) => {
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

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) throw new Error("Utilisateur non authentifié");

    const userId = claimsData.claims.sub as string;
    const userEmail = claimsData.claims.email as string;
    if (!userEmail) throw new Error("Email utilisateur requis");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const body = await req.json();
    const { action } = body;

    // ── CREATE MARKETPLACE CHECKOUT ──
    if (action === "create_checkout") {
      const { items, relay, package: packageData } = body;
      // items: [{ product_id, title, price, quantity, seller_id, thumbnail_url }]
      // relay: { id, name, address, postcode, city, country } (optional)

      if (!items?.length) throw new Error("Panier vide");

      // Validate items
      for (const item of items) {
        if (!item.product_id || !item.title || typeof item.price !== "number" || item.price <= 0) {
          throw new Error("Données produit invalides");
        }
        if (!item.quantity || item.quantity < 1) {
          throw new Error("Quantité invalide");
        }
      }

      const subtotal = items.reduce((sum: number, item: any) => sum + item.price * item.quantity, 0);
      const commission = Math.round(subtotal * COMMISSION_RATE * 100) / 100;

      const weightGrams = Math.max(100, Number(packageData?.weight_grams) || 500);
      const parcels = Math.max(1, Number(packageData?.parcels) || 1);
      const shippingFee = relay?.id ? estimateRelayShipping(weightGrams, parcels) : 0;

      const total = subtotal + commission + shippingFee;

      // Find or create Stripe customer
      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
      let customerId: string | undefined;
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      }

      // Build line items for Stripe
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = items.map((item: any) => ({
        price_data: {
          currency: "eur",
          product_data: {
            name: item.title,
            images: item.thumbnail_url ? [item.thumbnail_url] : [],
          },
          unit_amount: Math.round(item.price * 100), // cents
        },
        quantity: item.quantity,
      }));

      // Add commission as separate line item
      if (commission > 0) {
        lineItems.push({
          price_data: {
            currency: "eur",
            product_data: {
              name: "Frais de service ForSure (5%)",
              images: [],
            },
            unit_amount: Math.round(commission * 100),
          },
          quantity: 1,
        });
      }

      if (shippingFee > 0) {
        lineItems.push({
          price_data: {
            currency: "eur",
            product_data: {
              name: "Livraison Mondial Relay (estimée)",
              images: [],
            },
            unit_amount: Math.round(shippingFee * 100),
          },
          quantity: 1,
        });
      }

      const origin = req.headers.get("origin") || "https://calm-connect-05.lovable.app";

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
        orderData.shipping_weight_grams = weightGrams;
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert(orderData)
        .select()
        .single();

      if (orderError) throw new Error(`Erreur création commande: ${orderError.message}`);

      // Create order items
      for (const item of items) {
        const itemSubtotal = item.price * item.quantity;
        const itemCommission = Math.round(itemSubtotal * COMMISSION_RATE * 100) / 100;

        await supabase.from("order_items").insert({
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
      }

      // Create Stripe Checkout session
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        customer_email: customerId ? undefined : userEmail,
        line_items: lineItems,
        mode: "payment",
        success_url: `${origin}/marketplace?order_success=${order.id}`,
        cancel_url: `${origin}/marketplace?order_canceled=true`,
        metadata: {
          user_id: userId,
          order_id: order.id,
          order_number: orderNumber,
        },
      });

      // Store payment intent reference
      if (session.payment_intent) {
        await supabase
          .from("orders")
          .update({ payment_intent_id: session.payment_intent as string })
          .eq("id", order.id);
      }

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

      if (order.status === "paid") {
        return new Response(JSON.stringify({ paid: true, order }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check with Stripe if payment succeeded
      if (order.payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id);
        if (pi.status === "succeeded") {
          await supabase
            .from("orders")
            .update({ status: "paid", paid_at: new Date().toISOString() })
            .eq("id", orderId);

          await supabase
            .from("order_items")
            .update({ status: "paid" })
            .eq("order_id", orderId);

          // Notify sellers
          const { data: orderItems } = await supabase
            .from("order_items")
            .select("seller_id")
            .eq("order_id", orderId);
          const sellerIds = [...new Set((orderItems || []).map((i: any) => i.seller_id))];
          for (const sellerId of sellerIds) {
            const { data: sellerProfile } = await supabase
              .from("seller_profiles")
              .select("user_id")
              .eq("id", sellerId)
              .single();
            if (sellerProfile) {
              await supabase.from("notifications").insert({
                user_id: sellerProfile.user_id,
                actor_id: userId,
                type: "sale",
              });
            }
          }

          // Clear the buyer's cart
          await supabase.from("cart_items").delete().eq("user_id", userId);

          return new Response(JSON.stringify({ paid: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({ paid: false, status: order.status }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── TEST CHECKOUT (skip Stripe) ──
    if (action === "test_checkout") {
      const { items, relay, package: packageData } = body;
      if (!items?.length) throw new Error("Panier vide");

      const subtotal = items.reduce((sum: number, item: any) => sum + item.price * item.quantity, 0);
      const commission = Math.round(subtotal * COMMISSION_RATE * 100) / 100;

      const weightGrams = Math.max(100, Number(packageData?.weight_grams) || 500);
      const parcels = Math.max(1, Number(packageData?.parcels) || 1);
      const shippingFee = relay?.id ? estimateRelayShipping(weightGrams, parcels) : 0;

      const total = subtotal + commission + shippingFee;

      const orderNumber = `TEST-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

      const orderData: any = {
        buyer_id: userId,
        order_number: orderNumber,
        subtotal,
        total,
        commission_rate: COMMISSION_RATE,
        commission_amount: commission,
        status: "paid",
        paid_at: new Date().toISOString(),
      };

      if (relay?.id) {
        orderData.shipping_method = 'mondial_relay';
        orderData.shipping_relay_id = relay.id;
        orderData.shipping_relay_name = relay.name;
        orderData.shipping_relay_address = relay.address;
        orderData.shipping_relay_postcode = relay.postcode;
        orderData.shipping_relay_city = relay.city;
        orderData.shipping_relay_country = relay.country || 'FR';
        orderData.shipping_weight_grams = weightGrams;
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert(orderData)
        .select()
        .single();

      if (orderError) throw new Error(`Erreur création commande: ${orderError.message}`);

      for (const item of items) {
        const itemSubtotal = item.price * item.quantity;
        const itemCommission = Math.round(itemSubtotal * COMMISSION_RATE * 100) / 100;
        await supabase.from("order_items").insert({
          order_id: order.id,
          product_id: item.product_id,
          seller_id: item.seller_id,
          title: item.title,
          price: item.price,
          quantity: item.quantity,
          subtotal: itemSubtotal,
          commission_amount: itemCommission,
          seller_payout: itemSubtotal - itemCommission,
          status: "paid",
        });
      }

      // Notify sellers
      const sellerIds = [...new Set(items.map((i: any) => i.seller_id).filter(Boolean))];
      for (const sellerId of sellerIds) {
        const { data: sellerProfile } = await supabase
          .from("seller_profiles")
          .select("user_id")
          .eq("id", sellerId)
          .single();
        if (sellerProfile) {
          await supabase.from("notifications").insert({
            user_id: sellerProfile.user_id,
            actor_id: userId,
            type: "sale",
          });
        }
      }

      // Clear cart
      await supabase.from("cart_items").delete().eq("user_id", userId);

      return new Response(JSON.stringify({ success: true, orderId: order.id, orderNumber }), {
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
});
