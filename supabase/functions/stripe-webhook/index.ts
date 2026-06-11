import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

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

  if (!signature || !webhookSecret) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature header or webhook secret" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.text();
    const event: Stripe.Event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

    console.log("Stripe webhook event:", event.type, event.id);

    // ── IDEMPOTENCE: skip if event already processed ──
    const { data: isNew, error: idemErr } = await supabase.rpc(
      "stripe_mark_event_processed",
      { p_event_id: event.id, p_event_type: event.type }
    );
    if (idemErr) {
      console.error("[stripe-webhook] idempotence check failed", idemErr.message);
      // Fail-open on infra error; Stripe will retry on non-200
    } else if (isNew === false) {
      console.log(`[stripe-webhook] event ${event.id} already processed — skipping`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (event.type === "checkout_sessions.completed" || event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadataType = session.metadata?.type;

      // ── TIP PAYMENT ──
      if (metadataType === "tip") {
        const stripeSessionId = session.id;
        console.log(`Processing tip payment for session ${stripeSessionId}`);

        await supabase
          .from("tips")
          .update({ status: "completed" })
          .eq("stripe_session_id", stripeSessionId);

        // Notify the creator
        const tipperId = session.metadata?.tipper_id;
        const creatorId = session.metadata?.creator_id;
        if (tipperId && creatorId) {
          await supabase.from("notifications").insert({
            user_id: creatorId,
            actor_id: tipperId,
            type: "like",
          });
        }

        console.log(`✅ Tip confirmed for session ${stripeSessionId}`);
      }
      // ── SUBSCRIPTION (Creator) ──
      else if (!session.metadata?.order_id && session.metadata?.user_id && session.mode === "subscription") {
        const userId = session.metadata.user_id;
        console.log(`Processing creator subscription for user ${userId}`);

        // Activate creator status
        await supabase
          .from("profiles")
          .update({ is_creator: true, creator_since: new Date().toISOString(), creator_tier: "creator" })
          .eq("user_id", userId);

        // Upsert creator_subscriptions
        await supabase.from("creator_subscriptions").upsert({
          user_id: userId,
          status: "active",
          plan: "creator_monthly",
          price_cents: 500,
          currency: "eur",
          stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null,
          stripe_subscription_id: typeof session.subscription === "string" ? session.subscription : session.subscription?.id || null,
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        }, { onConflict: "user_id" });

        console.log(`✅ Creator activated for user ${userId}`);
      }
      // ── ORDER PAYMENT ──
      else {
        const orderId = session.metadata?.order_id;
        const userId = session.metadata?.user_id;

        if (!orderId) {
          console.log("No order_id or subscription in metadata, skipping");
          return new Response(JSON.stringify({ received: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        console.log(`Processing payment for order ${orderId}, user ${userId}`);

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

        await supabase
          .from("order_items")
          .update({ status: "paid" })
          .eq("order_id", orderId);

        const { data: orderItems } = await supabase
          .from("order_items")
          .select("product_id, quantity, seller_id")
          .eq("order_id", orderId);

        if (orderItems) {
          for (const item of orderItems) {
            // Atomic decrement (no read-then-update race). NULL stock = unlimited → no-op.
            const { error: stockErr } = await supabase.rpc("decrement_product_stock", {
              p_product_id: item.product_id,
              p_quantity: item.quantity,
            });
            if (stockErr) {
              console.error(`[stripe-webhook] stock decrement failed for ${item.product_id}`, stockErr.message);
            }
          }

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

        await supabase.from("cart_items").delete().eq("user_id", order.buyer_id);
        console.log(`✅ Order ${orderId} marked as paid via webhook`);
      }
    }

    // ── CHECKOUT SESSION EXPIRED ──
    if (event.type === "checkout.session.expired" || event.type === "checkout_sessions.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadataType = session.metadata?.type;

      if (metadataType === "tip") {
        await supabase
          .from("tips")
          .update({ status: "expired" })
          .eq("stripe_session_id", session.id);
        console.log(`❌ Tip session ${session.id} expired`);
      } else {
        const orderId = session.metadata?.order_id;
        if (orderId) {
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
    }

    // ── SUBSCRIPTION DELETED (Creator unsubscribes) ──
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;

      if (customerId) {
        const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
        if (customer?.email) {
          const { data: users } = await supabase.auth.admin.listUsers();
          const matchedUser = users?.users?.find((u) => u.email === customer.email);

          if (matchedUser) {
            await supabase
              .from("profiles")
              .update({ is_creator: false, creator_tier: "free" })
              .eq("user_id", matchedUser.id);

            await supabase
              .from("creator_subscriptions")
              .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
              .eq("user_id", matchedUser.id);

            console.log(`✅ Creator subscription cancelled for user ${matchedUser.id}`);
          }
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
