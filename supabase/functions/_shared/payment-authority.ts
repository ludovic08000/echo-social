// Les droits et montants sont décidés par le serveur, jamais par le prix ou l'état fourni par le navigateur.
export type CreatorPlan = "creator_essential" | "creator_pro" | "creator_studio";
export const DEFAULT_CREATOR_PRICE_ID = "price_1UOT8Q6wgOEGAgcGDX1iQ2Lt";

export const CREATOR_PLANS: Record<CreatorPlan, { env: string; amount: number; fallback?: string }> = {
  creator_essential: {
    env: "STRIPE_CREATOR_ESSENTIAL_PRICE_ID",
    amount: 499,
    fallback: Deno.env.get("STRIPE_CREATOR_PRICE_ID") || DEFAULT_CREATOR_PRICE_ID,
  },
  creator_pro: { env: "STRIPE_CREATOR_PRO_PRICE_ID", amount: 999 },
  creator_studio: { env: "STRIPE_CREATOR_STUDIO_PRICE_ID", amount: 1999 },
};

export const creatorPriceId = (plan: CreatorPlan): string | null =>
  Deno.env.get(CREATOR_PLANS[plan].env) || CREATOR_PLANS[plan].fallback || null;

export function creatorPlanForPrice(price: any): CreatorPlan | null {
  for (const [plan, config] of Object.entries(CREATOR_PLANS) as Array<[CreatorPlan, typeof CREATOR_PLANS[CreatorPlan]]>) {
    const expectedId = creatorPriceId(plan);
    if (expectedId && price?.id === expectedId && price.active === true && price.currency === "eur"
      && price.unit_amount === config.amount && price.recurring?.interval === "month"
      && (price.recurring.interval_count ?? 1) === 1) return plan;
  }
  return null;
}

export const isCreatorPrice = (price: any): boolean => creatorPlanForPrice(price) !== null;

export async function hasActiveCreatorSubscription(db: any, userId: string): Promise<boolean> {
  const { data, error } = await db.from("creator_subscriptions")
    .select("status, plan, stripe_subscription_id, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.status === "active"
    && ["creator_essential", "creator_pro", "creator_studio"].includes(data.plan)
    && Boolean(data.stripe_subscription_id)
    && new Date(data.current_period_end ?? 0).getTime() > Date.now();
}

export function paymentReturnOrigin(req: Request): string {
  const configured = Deno.env.get("APP_PUBLIC_URL") || "https://forsure.fans";
  const allowed = new Set(["https://forsure.fans", "https://www.forsure.fans"]);
  try { allowed.add(new URL(configured).origin); } catch { /* Le domaine de production reste autorisé. */ }
  const origin = req.headers.get("origin");
  return origin && allowed.has(origin) ? origin : "https://forsure.fans";
}

const objectId = (value: any): string | null => typeof value === "string" ? value : value?.id ?? null;

export function assertMarketplacePayment(session: any, intent: any, order: any): void {
  const amount = Math.round(Number(order.total) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || session.mode !== "payment"
    || session.payment_status !== "paid" || session.currency !== "eur" || session.amount_total !== amount
    || session.metadata?.order_id !== order.id || session.metadata?.user_id !== order.buyer_id
    || (order.stripe_checkout_session_id && session.id !== order.stripe_checkout_session_id)
    || (order.stripe_customer_id && objectId(session.customer) !== order.stripe_customer_id)
    || (session.client_reference_id && session.client_reference_id !== order.buyer_id)
    || !intent?.id || objectId(session.payment_intent) !== intent.id
    || (order.payment_intent_id && order.payment_intent_id !== intent.id)
    || intent.status !== "succeeded" || intent.currency !== "eur"
    || intent.amount !== amount || intent.amount_received !== amount
    || (objectId(session.customer) && objectId(intent.customer) !== objectId(session.customer))
    || (intent.metadata?.order_id && intent.metadata.order_id !== order.id)
    || (intent.metadata?.user_id && intent.metadata.user_id !== order.buyer_id)) {
    throw new Error("PAYMENT_BINDING_MISMATCH");
  }
}

export async function settleMarketplacePayment(db: any, stripe: any, order: any, suppliedSession?: any) {
  let session = suppliedSession;
  if (!session && order.stripe_checkout_session_id) {
    session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
  } else if (!session && order.payment_intent_id) {
    // Les commandes historiques ne sont reconnues qu'après lecture d'une session Stripe liée à cette commande exacte.
    const sessions = await stripe.checkout.sessions.list({ payment_intent: order.payment_intent_id, limit: 100 });
    session = sessions.data.find((candidate: any) => candidate.metadata?.order_id === order.id
      && candidate.metadata?.user_id === order.buyer_id);
  }
  if (!session || session.payment_status !== "paid") return false;
  const intentId = objectId(session.payment_intent);
  if (!intentId) return false;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  assertMarketplacePayment(session, intent, order);
  const { error } = await db.rpc("settle_marketplace_payment", {
    p_order_id: order.id, p_buyer_id: order.buyer_id, p_session_id: session.id,
    p_payment_intent_id: intent.id, p_amount_cents: session.amount_total, p_currency: session.currency,
  });
  if (error) throw error;
  return true;
}
