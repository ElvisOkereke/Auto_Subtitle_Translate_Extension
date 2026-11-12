// The hosted proxy's HTTP API (Hono). createApp takes every dependency so tests
// run it in-process (app.request) with fakes.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Auth, AuthEnv, clientIp, validEmail } from './auth';
import type { ServerConfig } from './config';
import type { Account, Repo } from './db';
import { Mailer, OutboxMailer, ResendMailer } from './mailer';
import { BUDGET_WARN_SHARE, PLANS, isActive, isPaidPlan } from './plans';
import { mountTranslate } from './translate';
import { StripeLike, mountBilling } from './billing';
import Stripe from 'stripe';

export interface AppDeps {
  config: ServerConfig;
  repo: Repo;
  mailer?: Mailer;
  /** Stripe client (null = billing disabled); defaults to the real SDK when STRIPE_SECRET_KEY is set. */
  stripe?: StripeLike | null;
  /** Upstream HTTP (Anthropic, DeepL); tests pass a fake. */
  fetch?: typeof fetch;
  /** Time source (tests move it). */
  clock?: () => number;
}

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

/**
 * Usage bucket: the Stripe billing period the account is in (so a subscription
 * started on the 31st doesn't get a second budget on the 1st), or the calendar
 * month for plans set by hand.
 */
export const periodOf = (account: Account, now: number) => (account.periodStart ? `p${new Date(account.periodStart).toISOString().slice(0, 10)}` : monthOf(now));

/** What an account may spend this period and has spent. */
export function accountStatus(repo: Repo, account: Account, now: number) {
  const month = periodOf(account, now);
  const active = isPaidPlan(account.plan) && isActive(account.subscriptionStatus);
  const budgetUsd = active && isPaidPlan(account.plan) ? PLANS[account.plan].budgetUsd : 0;
  const usageUsd = repo.usageFor(account.id, month).costUsd;
  return {
    email: account.email,
    plan: account.plan,
    status: account.subscriptionStatus,
    active,
    month,
    usageUsd,
    budgetUsd,
    warn: active && usageUsd >= budgetUsd * BUDGET_WARN_SHARE,
    exhausted: active && usageUsd >= budgetUsd,
  };
}

function defaultMailer(config: ServerConfig): Mailer {
  if (config.devOutbox || !config.mail.resendApiKey) return new OutboxMailer();
  return new ResendMailer(config.mail.resendApiKey, config.mail.from);
}

export function createApp(deps: AppDeps): Hono<AuthEnv> {
  const { config, repo } = deps;
  const clock = deps.clock ?? Date.now;
  const mailer = deps.mailer ?? defaultMailer(config);
  const auth = new Auth(repo, mailer, clock);
  const requireAccount = auth.requireAccount();
  const app = new Hono<AuthEnv>();

  // Every body is limited while it is read: 64 KB, 1 MB for Stripe webhooks.
  const tooLarge = (c: any) => c.json({ error: 'bad_request', message: 'request too large' }, 413);
  const smallBodies = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  const webhookBodies = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  app.use('*', (c, next) => (c.req.path === '/v1/stripe/webhook' ? webhookBodies(c, next) : smallBodies(c, next)));

  app.get('/health', c => c.json({ ok: true }));

  app.post('/v1/auth/start', async c => {
    const body = await c.req.json().catch(() => null);
    if (!validEmail(body?.email)) return c.json({ error: 'bad_request', message: 'Enter a valid email address.' }, 400);
    const result = await auth.start(body.email, clientIp(c, config.trustProxyHops));
    if (result === 'rate_limited') return c.json({ error: 'rate_limited', message: 'Too many codes requested. Try again later.' }, 429);
    return c.json({ ok: true });
  });

  app.post('/v1/auth/verify', async c => {
    const body = await c.req.json().catch(() => null);
    if (!validEmail(body?.email) || !/^\d{6}$/.test(String(body?.code ?? ''))) {
      return c.json({ error: 'bad_request', message: 'Enter the 6-digit code from the email.' }, 400);
    }
    const token = auth.verify(body.email, String(body.code), clientIp(c, config.trustProxyHops));
    if (token === 'locked') return c.json({ error: 'rate_limited', message: 'Too many wrong codes. Try again in an hour.' }, 429);
    if (!token) return c.json({ error: 'invalid_code', message: 'That code is wrong or expired. Request a new one.' }, 400);
    return c.json({ token });
  });

  app.post('/v1/auth/signout', requireAccount, c => {
    repo.revokeSession(c.get('tokenHash'));
    return c.json({ ok: true });
  });

  app.post('/v1/auth/signout-all', requireAccount, c => {
    repo.revokeAllSessions(c.get('account').id);
    return c.json({ ok: true });
  });

  app.get('/v1/me', requireAccount, c => c.json(accountStatus(repo, c.get('account'), clock())));

  const stripe = deps.stripe !== undefined ? deps.stripe : config.stripe.secretKey ? (new Stripe(config.stripe.secretKey) as unknown as StripeLike) : null;
  mountBilling(app, requireAccount, { config, repo, stripe });

  mountTranslate(app, requireAccount, { config, repo, clock, periodOf, status: account => accountStatus(repo, account, clock()), fetch: deps.fetch });

  if (config.devOutbox) {
    // Dev/test only: read the codes that would have been emailed.
    app.get('/dev/outbox', c => {
      const email = (c.req.query('email') ?? '').trim().toLowerCase();
      const messages = mailer instanceof OutboxMailer ? mailer.sent.filter(m => m.to === email) : [];
      return c.json({ messages });
    });
  }

  return app;
}
