// marketplace-checkout v2 - fixed is_active column
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

const COMMISSION_RATE = 0.05; // 5% buyer fee

function estimateRelayShipping(weightGrams: number): number {
  const base = 4.2;
  const extra =
    weightGrams <= 500 ? 0 :
    weightGrams <= 1000 ? 0.8 :
    weightGrams <= 2000 ? 1.6 :
    weightGrams <= 5000 ? 2.8 : 4.5;
  return Math.round((base + extra) * 100) / 100;
}

serve(async (req) => {
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

      if (!items?.length) throw new Error("Panier vide");

      // Validate items have required fields
      for (const item of items) {
        if (!item.product_id || !item.quantity || item.quantity < 1) {
          throw new Error("Données produit invalides");
        }
      }

      // SECURITY: Fetch real prices and data from DB — never trust client prices
      const productIds = items.map((i: any) => i.product_id);
      const { data: dbProducts, error: prodError } = await supabase
        .from("products")
        .select("id, title, price, seller_id, thumbnail_url, weight_grams, stock_quantity, is_active")
        .in("id", productIds);

      console.log("Product query:", { productIds, prodError, count: dbProducts?.length });
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

      const total = subtotal + commission + totalShipping;

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
        phone_number_collection: { enabled: false },
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

          // Decrement stock for purchased products
          const { data: paidItems } = await supabase
            .from("order_items")
            .select("product_id, quantity")
            .eq("order_id", orderId);
          if (paidItems) {
            for (const pi of paidItems) {
              const { data: prod } = await supabase
                .from("products")
                .select("stock_quantity")
                .eq("id", pi.product_id)
                .single();
              if (prod?.stock_quantity !== null && prod?.stock_quantity !== undefined) {
                await supabase
                  .from("products")
                  .update({ stock_quantity: Math.max(0, prod.stock_quantity - pi.quantity) })
                  .eq("id", pi.product_id);
              }
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

      const product = neg.products;
      if (!product) throw new Error("Produit introuvable");

      const agreedPrice = Number(neg.offered_price);
      const commission = Math.round(agreedPrice * COMMISSION_RATE * 100) / 100;

      // Calculate shipping
      let totalShipping = 0;
      let totalWeightGrams = 0;
      if (relay?.id) {
        const weight = product.weight_grams || 500;
        totalWeightGrams = weight;
        totalShipping = estimateRelayShipping(weight);
      }

      const total = agreedPrice + commission + totalShipping;

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
      await supabase.from("order_items").insert({
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

      // Update negotiation with order_id
      await supabase.from("negotiations").update({ order_id: order.id, status: "paid" }).eq("id", negotiationId);

      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
      let customerId: string | undefined;
      if (customers.data.length > 0) customerId = customers.data[0].id;

      const origin = req.headers.get("origin") || "https://calm-connect-05.lovable.app";

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

      if (commission > 0) {
        lineItems.push({
          price_data: {
            currency: "eur",
            product_data: { name: "Frais de service ForSure (5%)", images: [] },
            unit_amount: Math.round(commission * 100),
          },
          quantity: 1,
        });
      }

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
        phone_number_collection: { enabled: false },
        success_url: `${origin}/marketplace?order_success=${order.id}`,
        cancel_url: `${origin}/marketplace?order_canceled=true`,
        metadata: { user_id: userId, order_id: order.id, order_number: orderNumber, negotiation_id: negotiationId },
      });

      if (session.payment_intent) {
        await supabase.from("orders").update({ payment_intent_id: session.payment_intent as string }).eq("id", order.id);
      }

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
});
