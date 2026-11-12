// Stripe billing: Checkout (subscribe), Customer Portal (manage), webhooks that
// set the subscription flag, and the manual admin switch.
import { timingSafeEqual } from 'node:crypto';
import type { Hono, MiddlewareHandler } from 'hono';
import type Stripe from 'stripe';
import type { AuthEnv } from './auth';
import type { ServerConfig } from './config';
import type { Account, Repo } from './db';
import { Plan, isPaidPlan } from './plans';

/** The parts of the Stripe SDK the server uses (the real `Stripe` instance satisfies it). */
export interface StripeLike {
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }> } };
  webhooks: { constructEvent(payload: string, header: string, secret: string): Stripe.Event };
}

const ADMIN_PLANS: Plan[] = ['free', 'standard', 'pro'];

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
    if (!repo.recordStripeEvent(event.id)) return c.json({ ok: true, duplicate: true });
    const obj = event.data.object as any;
    switch (event.type) {
      case 'checkout.session.completed': {
        const account = repo.accountById(Number(obj.client_reference_id));
        const plan = obj.metadata?.plan;
        if (account && isPaidPlan(plan)) repo.setPlan(account.id, plan, 'active', typeof obj.customer === 'string' ? obj.customer : null);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const account = typeof obj.customer === 'string' ? repo.accountByCustomer(obj.customer) : null;
        const plan = planOfPrice(obj.items?.data?.[0]?.price?.id);
        if (account && plan) repo.setPlan(account.id, plan, String(obj.status));
        break;
      }
      case 'customer.subscription.deleted': {
        const account = typeof obj.customer === 'string' ? repo.accountByCustomer(obj.customer) : null;
        if (account) repo.setPlan(account.id, 'free', 'canceled');
        break;
      }
      case 'invoice.payment_failed': {
        const account = typeof obj.customer === 'string' ? repo.accountByCustomer(obj.customer) : null;
        if (account) repo.setPlan(account.id, account.plan, 'past_due');
        break;
      }
    }
    return c.json({ ok: true });
  });

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
