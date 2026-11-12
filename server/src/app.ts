// The hosted proxy's HTTP API (Hono). createApp takes every dependency so tests
// run it in-process (app.request) with fakes.
import { Hono } from 'hono';
import { Auth, AuthEnv, clientIp, validEmail } from './auth';
import type { ServerConfig } from './config';
import type { Account, Repo } from './db';
import { Mailer, OutboxMailer, ResendMailer } from './mailer';
import { BUDGET_WARN_SHARE, PLANS, isActive, isPaidPlan } from './plans';

export interface AppDeps {
  config: ServerConfig;
  repo: Repo;
  mailer?: Mailer;
  /** Time source (tests move it). */
  clock?: () => number;
}

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

/** What an account may spend this month and has spent. */
export function accountStatus(repo: Repo, account: Account, now: number) {
  const month = monthOf(now);
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

  app.get('/health', c => c.json({ ok: true }));

  app.post('/v1/auth/start', async c => {
    const body = await c.req.json().catch(() => null);
    if (!validEmail(body?.email)) return c.json({ error: 'bad_request', message: 'Enter a valid email address.' }, 400);
    const result = await auth.start(body.email, clientIp(c));
    if (result === 'rate_limited') return c.json({ error: 'rate_limited', message: 'Too many codes requested. Try again later.' }, 429);
    return c.json({ ok: true });
  });

  app.post('/v1/auth/verify', async c => {
    const body = await c.req.json().catch(() => null);
    if (!validEmail(body?.email) || !/^\d{6}$/.test(String(body?.code ?? ''))) {
      return c.json({ error: 'bad_request', message: 'Enter the 6-digit code from the email.' }, 400);
    }
    const token = auth.verify(body.email, String(body.code));
    if (!token) return c.json({ error: 'invalid_code', message: 'That code is wrong or expired. Request a new one.' }, 400);
    return c.json({ token });
  });

  app.post('/v1/auth/signout', requireAccount, c => {
    repo.revokeSession(c.get('tokenHash'));
    return c.json({ ok: true });
  });

  app.get('/v1/me', requireAccount, c => c.json(accountStatus(repo, c.get('account'), clock())));

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
