import Stripe from 'stripe';
import { createApp } from '../app';
import { sha256 } from '../auth';
import { setPlanCommand } from '../admin';
import { testDeps } from './helpers';

const realStripe = new Stripe('sk_test_dummy');

function setup() {
  const created: { checkout: any[]; portal: any[] } = { checkout: [], portal: [] };
  const stripe = {
    checkout: { sessions: { create: async (p: any) => (created.checkout.push(p), { url: 'https://checkout.stripe.test/c/session_1' }) } },
    billingPortal: { sessions: { create: async (p: any) => (created.portal.push(p), { url: 'https://billing.stripe.test/p/session_1' }) } },
    webhooks: realStripe.webhooks,
  };
  const deps = testDeps({ stripe });
  const app = createApp(deps);
  const account = deps.repo.upsertAccount('buyer@example.com');
  deps.repo.addSession(sha256('tok'), account.id);
  const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' };
  const webhook = (event: object, secret = deps.config.stripe.webhookSecret) => {
    const payload = JSON.stringify(event);
    const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
    return app.request('/v1/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
  };
  return { deps, app, account, auth, created, webhook };
}

const subscription = (customer: string, price: string, status: string) => ({ object: 'subscription', id: 'sub_1', customer, status, items: { data: [{ price: { id: price } }] } });

describe('billing', () => {
  it('checkout returns the Stripe URL for the chosen plan’s price', async () => {
    const { app, auth, created, account } = setup();
    const res = await app.request('/v1/billing/checkout', { method: 'POST', headers: auth, body: JSON.stringify({ plan: 'pro' }) });
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/c/session_1' });
    expect(created.checkout[0]).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_pro', quantity: 1 }],
      client_reference_id: String(account.id),
      customer_email: 'buyer@example.com',
      metadata: { plan: 'pro' },
    });
    expect((await app.request('/v1/billing/checkout', { method: 'POST', headers: auth, body: JSON.stringify({ plan: 'free' }) })).status).toBe(400);
  });

  it('checkout.session.completed activates the plan for client_reference_id', async () => {
    const { webhook, deps, account } = setup();
    const res = await webhook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { object: 'checkout.session', client_reference_id: String(account.id), customer: 'cus_9', metadata: { plan: 'standard' } } } });
    expect(res.status).toBe(200);
    expect(deps.repo.accountById(account.id)).toMatchObject({ plan: 'standard', subscriptionStatus: 'active', stripeCustomerId: 'cus_9' });
  });

  it('subscription updates, deletion and failed payments update or lapse the flag', async () => {
    const { webhook, deps, account } = setup();
    deps.repo.setPlan(account.id, 'standard', 'active', 'cus_9');
    await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: subscription('cus_9', 'price_pro', 'active') } });
    expect(deps.repo.accountById(account.id)).toMatchObject({ plan: 'pro', subscriptionStatus: 'active' });
    await webhook({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { object: 'invoice', customer: 'cus_9' } } });
    expect(deps.repo.accountById(account.id)).toMatchObject({ plan: 'pro', subscriptionStatus: 'past_due' });
    await webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: subscription('cus_9', 'price_pro', 'canceled') } });
    expect(deps.repo.accountById(account.id)).toMatchObject({ plan: 'free', subscriptionStatus: 'canceled' });
  });

  it('a webhook without a valid signature is 400 and changes nothing', async () => {
    const { app, webhook, deps, account } = setup();
    const event = { id: 'evt_5', type: 'checkout.session.completed', data: { object: { client_reference_id: String(account.id), customer: 'cus_x', metadata: { plan: 'pro' } } } };
    expect((await webhook(event, 'whsec_wrong')).status).toBe(400);
    expect((await app.request('/v1/stripe/webhook', { method: 'POST', body: JSON.stringify(event) })).status).toBe(400);
    expect(deps.repo.accountById(account.id)?.plan).toBe('free');
  });

  it('the same event delivered twice is applied once', async () => {
    const { webhook, deps, account } = setup();
    deps.repo.setPlan(account.id, 'pro', 'active', 'cus_9');
    const deleted = { id: 'evt_6', type: 'customer.subscription.deleted', data: { object: subscription('cus_9', 'price_pro', 'canceled') } };
    await webhook(deleted);
    deps.repo.setPlan(account.id, 'pro', 'active', 'cus_9'); // re-subscribed meanwhile
    const again = await webhook(deleted);
    expect(again.status).toBe(200);
    expect(deps.repo.accountById(account.id)?.plan).toBe('pro');
  });

  it('portal returns the Customer Portal URL for a customer, 400 without one', async () => {
    const { app, auth, deps, account, created } = setup();
    expect((await app.request('/v1/billing/portal', { method: 'POST', headers: auth })).status).toBe(400);
    deps.repo.setPlan(account.id, 'standard', 'active', 'cus_9');
    const res = await app.request('/v1/billing/portal', { method: 'POST', headers: auth });
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/p/session_1' });
    expect(created.portal[0]).toMatchObject({ customer: 'cus_9' });
  });

  it('admin endpoint requires the admin token and sets the plan', async () => {
    const { app, deps } = setup();
    const body = JSON.stringify({ email: 'friend@example.com', plan: 'pro' });
    expect((await app.request('/v1/admin/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    expect((await app.request('/v1/admin/plan', { method: 'POST', headers: { 'x-admin-token': 'nope', 'content-type': 'application/json' }, body })).status).toBe(401);
    const ok = await app.request('/v1/admin/plan', { method: 'POST', headers: { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' }, body });
    expect(ok.status).toBe(200);
    expect(deps.repo.accountByEmail('friend@example.com')).toMatchObject({ plan: 'pro', subscriptionStatus: 'active' });
  });

  it('admin endpoint is disabled when no admin token is configured', async () => {
    const deps = testDeps({ config: { ...testDeps().config, adminToken: '' } });
    const res = await createApp(deps).request('/v1/admin/plan', { method: 'POST', headers: { 'x-admin-token': '', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', plan: 'pro' }) });
    expect(res.status).toBe(401);
  });

  it('admin CLI set-plan sets the plan', () => {
    const { deps } = setup();
    expect(setPlanCommand(deps.repo, ['set-plan', 'cli@example.com', 'standard'])).toMatch(/standard/);
    expect(deps.repo.accountByEmail('cli@example.com')).toMatchObject({ plan: 'standard', subscriptionStatus: 'active' });
    expect(setPlanCommand(deps.repo, ['set-plan', 'cli@example.com', 'free'])).toMatch(/free/);
    expect(deps.repo.accountByEmail('cli@example.com')).toMatchObject({ plan: 'free', subscriptionStatus: null });
    expect(() => setPlanCommand(deps.repo, ['set-plan', 'cli@example.com', 'gold'])).toThrow(/plan/);
  });
});
