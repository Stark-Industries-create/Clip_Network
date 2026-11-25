import Stripe from 'stripe';
import { SAAS_PLANS, type PlanTier } from '@clip-network/shared';

let cachedStripe: { key: string; client: Stripe } | null = null;

export function isStripeLiveConfigured(): boolean {
  const key = process.env['STRIPE_SECRET_KEY']?.trim();
  return Boolean(key && /^(sk|rk)_/.test(key));
}

/** The client follows the current key, so a key saved by a super admin applies without a restart. */
export function getStripeClient(): Stripe | null {
  const key = process.env['STRIPE_SECRET_KEY']?.trim();
  if (!key || !/^(sk|rk)_/.test(key)) return null;
  if (cachedStripe?.key !== key) {
    cachedStripe = { key, client: new Stripe(key) };
    resolvedPrices.clear();
  }
  return cachedStripe.client;
}

const PAID_TIERS = ['STARTER', 'PRO', 'ENTERPRISE'] as const;
type PaidTier = typeof PAID_TIERS[number];
const lookupKey = (tier: PaidTier) => `clip_network_${tier.toLowerCase()}_monthly`;
const resolvedPrices = new Map<PaidTier, string>();

function configuredPriceId(tier: PaidTier) {
  return process.env[`STRIPE_PRICE_${tier}`]?.trim() || null;
}

/**
 * The Stripe price for a plan: the configured price ID when set, otherwise the monthly price this
 * app created earlier (found by lookup key), otherwise a new product and price made from the plan.
 */
export async function getStripePriceIdForPlan(planTier: PlanTier): Promise<string | null> {
  if (!(PAID_TIERS as readonly string[]).includes(planTier)) return null;
  const tier = planTier as PaidTier;
  const configured = configuredPriceId(tier);
  if (configured) return configured;
  const stripe = getStripeClient();
  if (!stripe) return null;
  const cached = resolvedPrices.get(tier);
  if (cached) return cached;
  const plan = SAAS_PLANS[tier];
  const amount = Math.round(plan.priceMonthlyUsd * 100);
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey(tier)], active: true, limit: 1 });
  let price = existing.data[0];
  if (!price || price.unit_amount !== amount) {
    price = await stripe.prices.create({
      currency: 'usd', unit_amount: amount, recurring: { interval: 'month' }, lookup_key: lookupKey(tier),
      transfer_lookup_key: true, metadata: { planTier: tier },
      product_data: { name: `Clip Network ${plan.name}`, metadata: { planTier: tier } },
    });
  }
  resolvedPrices.set(tier, price.id);
  return price.id;
}

/** Creates (or reuses) every paid plan's price in Stripe. Returns the price ID per plan. */
export async function ensureStripePlanPrices() {
  const result: Record<string, string | null> = {};
  for (const tier of PAID_TIERS) result[tier] = await getStripePriceIdForPlan(tier);
  return result;
}

export function resolvePlanTierFromPriceId(
  priceId: string | null | undefined,
  price?: { lookup_key?: string | null; metadata?: Record<string, string> | null } | null,
): PlanTier | null {
  if (!priceId) return null;
  for (const tier of PAID_TIERS) {
    if (priceId === configuredPriceId(tier) || priceId === resolvedPrices.get(tier)) return tier;
    if (price?.lookup_key === lookupKey(tier)) return tier;
  }
  const tagged = price?.metadata?.['planTier'];
  return tagged && (PAID_TIERS as readonly string[]).includes(tagged) ? tagged as PlanTier : null;
}

export const STRIPE_WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
];

/** Registers this server's webhook endpoint in Stripe and returns its signing secret. */
export async function createStripeWebhookEndpoint(publicApiUrl: string) {
  const stripe = getStripeClient();
  if (!stripe) throw new Error('Save a Stripe secret key first.');
  const url = new URL('/api/v1/billing/webhook/stripe', publicApiUrl).href;
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  for (const endpoint of existing.data) {
    // Secrets are only returned at creation, so replace an earlier endpoint for this URL.
    if (endpoint.url === url) await stripe.webhookEndpoints.del(endpoint.id);
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url, enabled_events: STRIPE_WEBHOOK_EVENTS, description: 'Clip Network subscriptions',
  });
  if (!endpoint.secret) throw new Error('Stripe did not return a signing secret.');
  return { url, secret: endpoint.secret, id: endpoint.id };
}

/** Confirms the key works and reports which account and mode it belongs to. */
export async function checkStripeAccount() {
  const stripe = getStripeClient();
  if (!stripe) return null;
  const account = await stripe.accounts.retrieveCurrent();
  return {
    accountName: account.settings?.dashboard?.display_name || account.business_profile?.name || account.id,
    livemode: process.env['STRIPE_SECRET_KEY']!.includes('_live_'),
    chargesEnabled: account.charges_enabled ?? null,
  };
}

export async function createStripeCheckoutSession(params: {
  workspaceId: string;
  workspaceName: string;
  customerEmail: string;
  existingCustomerId?: string | null;
  planTier: PlanTier;
  publicAppUrl: string;
}): Promise<{ checkoutUrl: string; sessionId: string; customerId: string } | null> {
  const stripe = getStripeClient();
  const priceId = await getStripePriceIdForPlan(params.planTier);
  if (!stripe || !priceId) return null;

  let customerId = params.existingCustomerId ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: params.customerEmail,
      name: params.workspaceName,
      metadata: { workspaceId: params.workspaceId },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${params.publicAppUrl}/settings/billing?checkout=success`,
    cancel_url: `${params.publicAppUrl}/settings/billing?checkout=cancelled`,
    metadata: {
      workspaceId: params.workspaceId,
      planTier: params.planTier,
    },
    subscription_data: {
      metadata: {
        workspaceId: params.workspaceId,
        planTier: params.planTier,
      },
    },
  });

  if (!session.url) return null;
  return { checkoutUrl: session.url, sessionId: session.id, customerId };
}

export async function createStripeBillingPortalSession(params: {
  customerId: string;
  publicAppUrl: string;
}): Promise<{ portalUrl: string } | null> {
  const stripe = getStripeClient();
  if (!stripe) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: `${params.publicAppUrl}/settings/billing`,
  });
  return { portalUrl: session.url };
}

export async function cancelStripeSubscriptionIfActive(subscriptionId: string | null | undefined) {
  const stripe = getStripeClient();
  if (!stripe || !subscriptionId) throw new Error('Stripe cancellation is unavailable');
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.status === 'canceled') return;
  await stripe.subscriptions.cancel(subscriptionId);
}

export function constructVerifiedStripeEvent(
  rawBody: string | Buffer,
  stripeSignature: string | undefined,
): Stripe.Event | null {
  const stripe = getStripeClient();
  const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET']?.trim();
  if (!stripe || !webhookSecret || !stripeSignature) return null;
  return stripe.webhooks.constructEvent(rawBody, stripeSignature, webhookSecret);
}
