import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
    apiVersion: "2025-08-27.basil",
  });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.text();

    let event: Stripe.Event;

    if (webhookSecret) {
      // Verify signature when webhook secret is configured
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } else {
      // Fallback: parse without verification (dev mode)
      console.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
      event = JSON.parse(body) as Stripe.Event;
    }

    console.log("Stripe webhook event:", event.type);

    // ── CHECKOUT SESSION COMPLETED ──
    if (event.type === "checkout_sessions.completed" || event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id;
      const userId = session.metadata?.user_id;

      if (!orderId) {
        console.log("No order_id in metadata, skipping (may be a subscription checkout)");
        return new Response(JSON.stringify({ received: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`Processing payment for order ${orderId}, user ${userId}`);

      // Check if order is already paid (idempotency)
      const { data: order } = await supabase
        .from("orders")
        .select("id, status, buyer_id")
        .eq("id", orderId)
        .single();

      if (!order) {
        console.error(`Order ${orderId} not found`);
        return new Response(JSON.stringify({ received: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (order.status === "paid" || order.status === "shipped" || order.status === "delivered") {
        console.log(`Order ${orderId} already processed (status: ${order.status})`);
        return new Response(JSON.stringify({ received: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Update order to paid
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id || null;

      await supabase
        .from("orders")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          payment_intent_id: paymentIntentId,
        })
        .eq("id", orderId);

      // Update order items
      await supabase
        .from("order_items")
        .update({ status: "paid" })
        .eq("order_id", orderId);

      // Decrement stock
      const { data: orderItems } = await supabase
        .from("order_items")
        .select("product_id, quantity, seller_id")
        .eq("order_id", orderId);

      if (orderItems) {
        for (const item of orderItems) {
          const { data: prod } = await supabase
            .from("products")
            .select("stock_quantity")
            .eq("id", item.product_id)
            .single();

          if (prod?.stock_quantity !== null && prod?.stock_quantity !== undefined) {
            await supabase
              .from("products")
              .update({
                stock_quantity: Math.max(0, prod.stock_quantity - item.quantity),
              })
              .eq("id", item.product_id);
          }
        }

        // Notify sellers
        const sellerIds = [...new Set(orderItems.map((i) => i.seller_id).filter(Boolean))];
        for (const sellerId of sellerIds) {
          const { data: sellerProfile } = await supabase
            .from("seller_profiles")
            .select("user_id")
            .eq("id", sellerId)
            .single();

          if (sellerProfile) {
            await supabase.from("notifications").insert({
              user_id: sellerProfile.user_id,
              actor_id: order.buyer_id,
              type: "sale",
            });
          }
        }
      }

      // Clear buyer's cart
      await supabase.from("cart_items").delete().eq("user_id", order.buyer_id);

      console.log(`✅ Order ${orderId} marked as paid via webhook`);
    }

    // ── PAYMENT FAILED ──
    if (event.type === "checkout.session.expired" || event.type === "checkout_sessions.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id;

      if (orderId) {
        // Mark order as cancelled if payment session expired
        const { data: order } = await supabase
          .from("orders")
          .select("status")
          .eq("id", orderId)
          .single();

        if (order?.status === "pending") {
          await supabase
            .from("orders")
            .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
            .eq("id", orderId);

          await supabase
            .from("order_items")
            .update({ status: "cancelled" })
            .eq("order_id", orderId);

          console.log(`❌ Order ${orderId} cancelled (session expired)`);
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
