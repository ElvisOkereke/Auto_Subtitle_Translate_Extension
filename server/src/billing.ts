// Stripe billing: Checkout (subscribe), Customer Portal (manage), webhooks that
// set the subscription flag, and the manual admin switch.
import { timingSafeEqual } from 'node:crypto';
import type { Hono, MiddlewareHandler } from 'hono';
import type Stripe from 'stripe';
import type { AuthEnv } from './auth';
import type { ServerConfig } from './config';
import type { Account, Repo } from './db';
import { Plan, isActive, isPaidPlan } from './plans';

/** The parts of the Stripe SDK the server uses (the real `Stripe` instance satisfies it). */
export interface StripeLike {
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }> } };
  webhooks: { constructEvent(payload: string, header: string, secret: string): Stripe.Event };
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
}

/** Subscription states during which the account already has (or owes for) a subscription. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);
/** Subscription states that end it. */
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** The subscription id an event is about (shapes differ by event type and API version). */
function subscriptionIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as any;
  if (event.type.startsWith('customer.subscription.')) return typeof obj.id === 'string' ? obj.id : null;
  const id = obj.subscription ?? obj.parent?.subscription_details?.subscription ?? null;
  return typeof id === 'string' ? id : (id?.id ?? null);
}

/** Current billing period start (ms) of a subscription (newer API versions keep it on the item). */
function periodStartOf(sub: Stripe.Subscription | null): number | null {
  const item: any = sub?.items?.data?.[0];
  const seconds = item?.current_period_start ?? (sub as any)?.current_period_start;
  return typeof seconds === 'number' ? seconds * 1000 : null;
}

const ADMIN_PLANS: Plan[] = ['free', 'standard', 'pro'];
const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

function sameSecret(given: string, expected: string): boolean {
  if (!expected) return false; // admin disabled without a configured token
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mountBilling(app: Hono<AuthEnv>, requireAccount: MiddlewareHandler<AuthEnv>, deps: { config: ServerConfig; repo: Repo; stripe: StripeLike | null }): void {
  const { config, repo } = deps;
  const planOfPrice = (priceId: string | undefined): Plan | null =>
    priceId === config.stripe.prices.standard ? 'standard' : priceId === config.stripe.prices.pro ? 'pro' : null;
  const notConfigured = { error: 'billing_unavailable', message: 'Billing is not configured on this server.' };

  app.post('/v1/billing/checkout', requireAccount, async c => {
    if (!deps.stripe) return c.json(notConfigured, 503);
    const body = await c.req.json().catch(() => null);
    const plan = body?.plan;
    if (!isPaidPlan(plan) || !config.stripe.prices[plan]) return c.json({ error: 'bad_request', message: 'Choose standard or pro.' }, 400);
    const account: Account = c.get('account');
    // One subscription per account: changes and upgrades go through the Customer Portal.
    if (account.stripeCustomerId && LIVE_STATUSES.has(account.subscriptionStatus ?? '')) {
      return c.json({ error: 'already_subscribed', message: 'You already have a subscription - change it under "Manage subscription".' }, 409);
    }
    const session = await deps.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: config.stripe.prices[plan], quantity: 1 }],
      client_reference_id: String(account.id),
      ...(account.stripeCustomerId ? { customer: account.stripeCustomerId } : { customer_email: account.email }),
      metadata: { plan },
      success_url: `${config.publicUrl}/billing/done?result=success`,
      cancel_url: `${config.publicUrl}/billing/done?result=cancel`,
    });
    return c.json({ url: session.url });
  });

  app.post('/v1/billing/portal', requireAccount, async c => {
    if (!deps.stripe) return c.json(notConfigured, 503);
    const account: Account = c.get('account');
    if (!account.stripeCustomerId) return c.json({ error: 'bad_request', message: 'No subscription to manage yet.' }, 400);
    const session = await deps.stripe.billingPortal.sessions.create({ customer: account.stripeCustomerId, return_url: `${config.publicUrl}/billing/done?result=portal` });
    return c.json({ url: session.url });
  });

  app.get('/billing/done', c =>
    c.html('<!doctype html><meta charset="utf-8"><title>Auto Subtitle Translator</title><p style="font:16px system-ui;margin:3em">Done - you can close this tab and reopen the extension popup.</p>')
  );

  app.post('/v1/stripe/webhook', async c => {
    if (!deps.stripe || !config.stripe.webhookSecret) return c.json(notConfigured, 503);
    const payload = await c.req.text();
    let event: Stripe.Event;
    try {
      event = deps.stripe.webhooks.constructEvent(payload, c.req.header('stripe-signature') ?? '', config.stripe.webhookSecret);
    } catch {
      return c.json({ error: 'bad_signature', message: 'Invalid Stripe signature.' }, 400);
    }
    // Act on Stripe's current state of the subscription, not the event payload:
    // events arrive in any order, and some (e.g. a failed proration invoice) don't
    // change the subscription at all. Then record the event and apply it in one
    // transaction, so a failure means Stripe's retry gets processed.
    try {
      const subscriptionId = subscriptionIdOf(event);
      const current = subscriptionId && HANDLED.has(event.type) ? await deps.stripe.subscriptions.retrieve(subscriptionId) : null;
      const applied = repo.transaction(() => {
        if (!repo.recordStripeEvent(event.id)) return false;
        applyEvent(event, subscriptionId, current);
        return true;
      });
      return c.json(applied ? { ok: true } : { ok: true, duplicate: true });
    } catch (error) {
      console.error('Stripe webhook failed:', (error as Error).message);
      return c.json({ error: 'webhook_failed', message: 'Try again.' }, 500);
    }
  });

  /** Applies one billing event to its account using the subscription's current state. */
  function applyEvent(event: Stripe.Event, subscriptionId: string | null, current: Stripe.Subscription | null): void {
    const obj = event.data.object as any;
    const customerId = typeof obj.customer === 'string' ? obj.customer : null;

    if (event.type.startsWith('checkout.session.')) {
      const account = repo.accountById(Number(obj.client_reference_id));
      const plan = obj.metadata?.plan;
      if (!account || !isPaidPlan(plan)) return;
      const paid = event.type !== 'checkout.session.async_payment_failed' && (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required');
      if (paid) {
        repo.setPlan(account.id, plan, current?.status ?? 'active', customerId);
        repo.setSubscription(account.id, subscriptionId, periodStartOf(current));
      } else if (!isActive(account.subscriptionStatus)) {
        repo.setPlan(account.id, account.plan, 'incomplete', customerId); // payment pending/failed: no access yet
      }
      return;
    }

    // customer.subscription.* and invoice.payment_failed
    const account = customerId ? repo.accountByCustomer(customerId) : null;
    if (!account || !current) return;
    if (account.stripeSubscriptionId && account.stripeSubscriptionId !== current.id) return; // another subscription: not ours to follow
    if (ENDED_STATUSES.has(current.status)) {
      repo.setPlan(account.id, 'free', current.status);
      repo.setSubscription(account.id, current.id, null);
      return;
    }
    const plan = planOfPrice((current.items?.data?.[0] as any)?.price?.id) ?? account.plan;
    repo.setPlan(account.id, plan, current.status);
    repo.setSubscription(account.id, current.id, periodStartOf(current));
  }

  app.post('/v1/admin/plan', async c => {
    if (!sameSecret(c.req.header('x-admin-token') ?? '', config.adminToken)) return c.json({ error: 'unauthorized', message: 'Admin token required.' }, 401);
    const body = await c.req.json().catch(() => null);
    try {
      return c.json({ ok: true, message: applyPlan(repo, body?.email, body?.plan, body?.status) });
    } catch (error) {
      return c.json({ error: 'bad_request', message: (error as Error).message }, 400);
    }
  });
}

/** Sets an account's plan by hand (creating the account if needed); returns a summary. */
export function applyPlan(repo: Repo, email: unknown, plan: unknown, status?: unknown): string {
  if (typeof email !== 'string' || !email.includes('@')) throw new Error('email is required');
  if (!ADMIN_PLANS.includes(plan as Plan)) throw new Error(`plan must be one of ${ADMIN_PLANS.join(', ')}`);
  const account = repo.upsertAccount(email);
  const finalStatus = typeof status === 'string' && status ? status : plan === 'free' ? null : 'active';
  repo.setPlan(account.id, plan as Plan, finalStatus);
  return `${account.email}: plan ${plan}, status ${finalStatus ?? 'none'}`;
}
