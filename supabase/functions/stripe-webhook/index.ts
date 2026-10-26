import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { creatorPlanForPrice, CREATOR_PLANS, settleMarketplacePayment } from "../_shared/payment-authority.ts";

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

  let claimedEventId: string | null = null;
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
      throw idemErr;
    } else if (isNew === false) {
      console.log(`[stripe-webhook] event ${event.id} already processed — skipping`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    claimedEventId = event.id;

    if (event.type === "checkout_sessions.completed" || event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadataType = session.metadata?.type;

      // ── TIP PAYMENT ──
      if (metadataType === "tip") {
        const stripeSessionId = session.id;
        console.log(`Processing tip payment for session ${stripeSessionId}`);

        await supabase
          .from("tips")
          .update({ status: "completed", paid_at: new Date().toISOString() })
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
      // ── ADS CAMPAIGN PAYMENT ──
      else if (metadataType === "ad_campaign") {
        const campaignId = session.metadata?.campaign_id;
        const userId = session.metadata?.user_id;
        if (!campaignId || !userId) throw new Error("Ad campaign payment metadata is incomplete");
        if (session.payment_status !== "paid" || session.currency !== "eur") {
          throw new Error(`Ad campaign payment is not confirmed for ${campaignId}`);
        }

        const { data: campaign, error: campaignLookupError } = await supabase
          .from("ad_campaigns")
          .select("id, advertiser_id, budget, status, paid_at, starts_at, ends_at")
          .eq("id", campaignId)
          .eq("advertiser_id", userId)
          .maybeSingle();
        if (campaignLookupError) throw campaignLookupError;
        if (!campaign) throw new Error(`Ad campaign ${campaignId} not found for payment owner`);

        const expectedAmount = Math.round(Number(campaign.budget) * 100);
        if (!Number.isFinite(expectedAmount) || session.amount_total !== expectedAmount) {
          throw new Error(`Ad campaign amount mismatch for ${campaignId}`);
        }

        if (campaign.status !== "active" || !campaign.paid_at) {
          const originalStart = new Date(campaign.starts_at).getTime();
          const originalEnd = new Date(campaign.ends_at).getTime();
          const requestedDuration = originalEnd - originalStart;
          const durationMs = Math.min(
            90 * 24 * 60 * 60 * 1000,
            Math.max(24 * 60 * 60 * 1000, requestedDuration),
          );
          const startsAt = new Date();
          const endsAt = new Date(startsAt.getTime() + durationMs);

          const { error: campaignUpdateError } = await supabase
            .from("ad_campaigns")
            .update({
              status: "active",
              paid_at: startsAt.toISOString(),
              starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(),
            })
            .eq("id", campaignId)
            .eq("advertiser_id", userId);
          if (campaignUpdateError) throw campaignUpdateError;

          const { data: adSets, error: adSetUpdateError } = await supabase
            .from("ad_sets")
            .update({
              status: "active",
              starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(),
            })
            .eq("campaign_id", campaignId)
            .eq("advertiser_id", userId)
            .select("id");
          if (adSetUpdateError) throw adSetUpdateError;

          const adSetIds = (adSets || []).map((adSet) => adSet.id);
          if (adSetIds.length > 0) {
            const { error: adUpdateError } = await supabase
              .from("ads")
              .update({ status: "active" })
              .eq("advertiser_id", userId)
              .eq("moderation_status", "approved")
              .in("ad_set_id", adSetIds);
            if (adUpdateError) throw adUpdateError;
          }
        }

        console.log(`✅ Ad campaign activated for campaign ${campaignId}`);
      }
      // ── FAN SUBSCRIPTION (un fan rejoint le club d'un créateur) ──
      else if (metadataType === "fan_subscription") {
        const creatorId = session.metadata?.creator_id;
        const fanId = session.metadata?.fan_id;
        if (!creatorId || !fanId) throw new Error("Abonnement fan : métadonnées incomplètes");

        const subId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;
        let periodStart = new Date().toISOString();
        let periodEnd: string | null = null;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          if (sub.current_period_start) periodStart = new Date(sub.current_period_start * 1000).toISOString();
          if (sub.current_period_end) periodEnd = new Date(sub.current_period_end * 1000).toISOString();
        }

        const { error: fanUpdateErr } = await supabase
          .from("fan_subscriptions")
          .update({
            status: "active",
            stripe_subscription_id: subId,
            stripe_customer_id: typeof session.customer === "string"
              ? session.customer
              : session.customer?.id ?? null,
            current_period_start: periodStart,
            current_period_end: periodEnd,
          })
          .eq("creator_id", creatorId)
          .eq("fan_id", fanId);
        if (fanUpdateErr) throw new Error(`Activation de l'abonnement fan impossible : ${fanUpdateErr.message}`);

        await supabase.from("notifications").insert({
          user_id: creatorId,
          actor_id: fanId,
          type: "sale",
        });

        console.log(`✅ Fan ${fanId} subscribed to creator ${creatorId}`);
      }
      // ── SUBSCRIPTION (Creator) ──
      else if (!session.metadata?.order_id && session.metadata?.user_id && session.mode === "subscription") {
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!subscriptionId || session.payment_status !== "paid") throw new Error("CREATOR_PAYMENT_UNCONFIRMED");
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const creatorItems = subscription.items?.data ?? [];
        const creatorPlan = creatorItems.length === 1 ? creatorPlanForPrice(creatorItems[0].price) : null;
        if (subscription.status !== "active" || !creatorPlan || creatorItems[0].quantity !== 1) {
          throw new Error("CREATOR_PRICE_MISMATCH");
        }
        const userId = session.metadata.user_id;
        console.log(`Processing creator subscription for user ${userId}`);

        // Activate creator status
        const { error: creatorProfileError } = await supabase
          .from("profiles")
          .update({ is_creator: true, creator_since: new Date().toISOString(), creator_tier: creatorPlan })
          .eq("user_id", userId);
        if (creatorProfileError) throw creatorProfileError;

        // Upsert creator_subscriptions
        const { error: creatorSubscriptionError } = await supabase.from("creator_subscriptions").upsert({
          user_id: userId,
          status: "active",
          plan: creatorPlan,
          price_cents: CREATOR_PLANS[creatorPlan].amount,
          currency: "eur",
          stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null,
          stripe_subscription_id: typeof session.subscription === "string" ? session.subscription : session.subscription?.id || null,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        }, { onConflict: "user_id" });
        if (creatorSubscriptionError) throw creatorSubscriptionError;

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
          .select("*")
          .eq("id", orderId)
          .single();

        if (!order) {
          console.error(`Order ${orderId} not found`);
          return new Response(JSON.stringify({ received: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (!(await settleMarketplacePayment(supabase, stripe, order, session))) {
          throw new Error("ORDER_PAYMENT_UNCONFIRMED");
        }
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

    // ── SUBSCRIPTION DELETED (badge Créateur résilié ou fan qui quitte un club) ──
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const deletedSubId = typeof subscription.id === "string" ? subscription.id : null;

      // Un abonnement fan se clôture dans fan_subscriptions, jamais dans le badge Créateur.
      let fanCreatorId: string | null =
        subscription.metadata?.type === "fan_subscription" && typeof subscription.metadata?.creator_id === "string"
          ? subscription.metadata.creator_id
          : null;

      if (!fanCreatorId && deletedSubId) {
        const { data: fanRow } = await supabase
          .from("fan_subscriptions")
          .select("creator_id")
          .eq("stripe_subscription_id", deletedSubId)
          .maybeSingle();
        fanCreatorId = fanRow?.creator_id ?? null;
      }

      if (fanCreatorId && deletedSubId) {
        await supabase
          .from("fan_subscriptions")
          .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
          .eq("stripe_subscription_id", deletedSubId);
        console.log(`✅ Fan subscription ${deletedSubId} cancelled (creator ${fanCreatorId})`);
      } else {
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
    }

    // ── SUBSCRIPTION UPDATED (nouvelle période, impayé, ou résiliation programmée) ──
    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const subId = typeof subscription.id === "string" ? subscription.id : null;

      if (subId) {
        const periodStart = subscription.current_period_start
          ? new Date(subscription.current_period_start * 1000).toISOString()
          : null;
        const periodEnd = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null;

        const { data: fanRow } = await supabase
          .from("fan_subscriptions")
          .select("id")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();

        if (fanRow) {
          const nextStatus = subscription.status === "active"
            ? "active"
            : subscription.status === "past_due"
              ? "past_due"
              : subscription.status === "canceled"
                ? "cancelled"
                : null;

          await supabase
            .from("fan_subscriptions")
            .update({
              status: nextStatus ?? "active",
              current_period_start: periodStart,
              current_period_end: periodEnd,
            })
            .eq("id", fanRow.id);
          console.log(`✅ Fan subscription ${subId} updated (${subscription.status})`);
        } else {
          const item = subscription.items.data.length === 1 ? subscription.items.data[0] : null;
          const creatorPlan = item ? creatorPlanForPrice(item.price) : null;
          const nextStatus = subscription.status === "active" ? "active"
            : subscription.status === "past_due" ? "past_due" : "cancelled";
          await supabase
            .from("creator_subscriptions")
            .update({
              status: nextStatus,
              plan: creatorPlan ?? undefined,
              price_cents: creatorPlan ? CREATOR_PLANS[creatorPlan].amount : undefined,
              current_period_start: periodStart,
              current_period_end: periodEnd,
            })
            .eq("stripe_subscription_id", subId);
          console.log(`✅ Creator subscription ${subId} period refreshed`);
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    // Un traitement échoué ne doit jamais être mémorisé comme réussi : Stripe doit pouvoir le rejouer.
    if (claimedEventId) await supabase.from("stripe_processed_events").delete().eq("event_id", claimedEventId);
    console.error("Stripe webhook error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
