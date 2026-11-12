import { loadConfig } from '../config';
import { Repo } from '../db';
import type { AppDeps } from '../app';
import { OutboxMailer } from '../mailer';

/** In-memory dependencies for tests; override any part. */
export function testDeps(over: Partial<AppDeps> = {}): AppDeps {
  const config = loadConfig({ ADMIN_TOKEN: 'admin-secret', DEV_OUTBOX: '1', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_STANDARD: 'price_std', STRIPE_PRICE_PRO: 'price_pro', DEEPL_API_KEY: 'deepl-key', ANTHROPIC_API_KEY: 'sk-ant-service' });
  return { config, repo: new Repo(':memory:'), mailer: new OutboxMailer(), ...over } as AppDeps;
}
