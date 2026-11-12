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
    // Record the event and apply it in one transaction: a failure rolls both back,
    // so Stripe's retry is processed instead of being skipped as a duplicate.
    try {
      const applied = repo.transaction(() => {
        if (!repo.recordStripeEvent(event.id)) return false;
        applyEvent(event);
        return true;
      });
      return c.json(applied ? { ok: true } : { ok: true, duplicate: true });
    } catch (error) {
      console.error('Stripe webhook failed:', (error as Error).message);
      return c.json({ error: 'webhook_failed', message: 'Try again.' }, 500);
    }
  });

  /** Applies one billing event to its account, ignoring events older than the last one applied. */
  function applyEvent(event: Stripe.Event): void {
    const obj = event.data.object as any;
    const created = typeof event.created === 'number' ? event.created : null;
    const fresh = (account: Account) => {
      const last = repo.stripeEventAt(account.id);
      return created === null || last === null || created >= last;
    };
    const stamp = (account: Account) => {
      if (created !== null) repo.setStripeEventAt(account.id, created);
    };
    const accountOfCustomer = () => (typeof obj.customer === 'string' ? repo.accountByCustomer(obj.customer) : null);
    const customerId = typeof obj.customer === 'string' ? obj.customer : null;

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed': {
        const account = repo.accountById(Number(obj.client_reference_id));
        const plan = obj.metadata?.plan;
        if (!account || !isPaidPlan(plan) || !fresh(account)) return;
        const paid = event.type !== 'checkout.session.async_payment_failed' && (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required');
        if (paid) repo.setPlan(account.id, plan, 'active', customerId);
        else if (!isActive(account.subscriptionStatus)) repo.setPlan(account.id, account.plan, 'incomplete', customerId); // payment pending/failed: no access yet
        stamp(account);
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const account = accountOfCustomer();
        const plan = planOfPrice(obj.items?.data?.[0]?.price?.id);
        if (!account || !plan || !fresh(account)) return;
        repo.setPlan(account.id, plan, String(obj.status));
        stamp(account);
        return;
      }
      case 'customer.subscription.deleted': {
        const account = accountOfCustomer();
        if (!account || !fresh(account)) return;
        repo.setPlan(account.id, 'free', 'canceled');
        stamp(account);
        return;
      }
      case 'invoice.payment_failed': {
        const account = accountOfCustomer();
        if (!account || !fresh(account)) return;
        repo.setPlan(account.id, account.plan, 'past_due');
        stamp(account);
        return;
      }
    }
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
