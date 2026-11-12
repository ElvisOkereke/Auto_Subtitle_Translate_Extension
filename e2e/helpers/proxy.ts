// The hosted proxy (server/) started in the Playwright worker for E2E tests:
// real server code, temp SQLite, dev outbox for login codes, upstream Claude and
// DeepL pointed at the fixture server's mocks, and a fake Stripe whose Checkout
// URL is a page on the fixture server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/src/app';
import { loadConfig } from '../../server/src/config';
import { Repo } from '../../server/src/db';
import { OutboxMailer } from '../../server/src/mailer';
import type { Plan } from '../../server/src/plans';

export interface LocalProxy {
  url: string;
  repo: Repo;
  mailer: OutboxMailer;
  /** Last login code emailed to this address. */
  lastCode(email: string): string;
  setPlan(email: string, plan: Plan): void;
  usageUsd(email: string): number;
  close(): Promise<void>;
}

export async function startLocalProxy(fixtureServerUrl: string): Promise<LocalProxy> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-proxy-e2e-'));
  const repo = new Repo(path.join(dir, 'app.db'));
  const mailer = new OutboxMailer();
  const config = loadConfig({
    ADMIN_TOKEN: 'e2e-admin',
    DEV_OUTBOX: '1',
    ANTHROPIC_BASE_URL: `${fixtureServerUrl}/mock/anthropic`,
    ANTHROPIC_API_KEY: 'sk-service-proxy',
    DEEPL_API_KEY: 'service-deepl:fx',
    DEEPL_ENDPOINT: `${fixtureServerUrl}/mock/deepl`,
    STRIPE_SECRET_KEY: 'sk_test_e2e',
    STRIPE_WEBHOOK_SECRET: 'whsec_e2e',
    STRIPE_PRICE_STANDARD: 'price_std',
    STRIPE_PRICE_PRO: 'price_pro',
  });
  const stripe = {
    checkout: { sessions: { create: async () => ({ url: `${fixtureServerUrl}/fake-stripe-checkout.html` }) } },
    billingPortal: { sessions: { create: async () => ({ url: `${fixtureServerUrl}/fake-stripe-portal.html` }) } },
    webhooks: { constructEvent: () => { throw new Error('not used in E2E'); } },
  };
  const app = createApp({ config, repo, mailer, stripe: stripe as never });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>(resolve => (server.listening ? resolve() : server.once('listening', () => resolve())));
  const { port } = server.address() as AddressInfo;
  const email = (e: string) => e.trim().toLowerCase();
  return {
    url: `http://127.0.0.1:${port}`,
    repo,
    mailer,
    lastCode: e => mailer.sent.filter(m => m.to === email(e)).at(-1)!.text.match(/(\d{6})/)![1],
    setPlan: (e, plan) => {
      const account = repo.upsertAccount(e);
      repo.setPlan(account.id, plan, plan === 'free' ? null : 'active', plan === 'free' ? null : `cus_${account.id}`);
    },
    usageUsd: e => {
      const account = repo.accountByEmail(e);
      return account ? repo.usageFor(account.id, new Date().toISOString().slice(0, 7)).costUsd : 0;
    },
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          repo.close();
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
