// Les droits et montants sont décidés par le serveur, jamais par le prix ou l'état fourni par le navigateur.
export const DEFAULT_CREATOR_PRICE_ID = "price_1UOT8Q6wgOEGAgcGDX1iQ2Lt";
export const creatorPriceId = () => Deno.env.get("STRIPE_CREATOR_PRICE_ID") || DEFAULT_CREATOR_PRICE_ID;

export function isCreatorPrice(price: any): boolean {
  return price?.id === creatorPriceId() && price.active === true && price.currency === "eur"
    && price.unit_amount === 499 && price.recurring?.interval === "month"
    && (price.recurring.interval_count ?? 1) === 1;
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
