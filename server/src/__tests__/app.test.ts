import { createApp } from '../app';
import { testDeps } from './helpers';

describe('app', () => {
  it('GET /health returns ok', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('every route refuses bodies over 64 KB (the Stripe webhook over 1 MB)', async () => {
    const app = createApp(testDeps());
    const big = (n: number) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(n) }, body: 'x'.repeat(n) });
    for (const path of ['/v1/auth/start', '/v1/auth/verify', '/v1/billing/checkout', '/v1/admin/plan']) {
      expect((await app.request(path, big(70 * 1024))).status).toBe(413);
    }
    expect((await app.request('/v1/stripe/webhook', big(70 * 1024))).status).not.toBe(413); // signature check instead
    expect((await app.request('/v1/stripe/webhook', big(1_100_000))).status).toBe(413);
  });

  it('the database waits on locks instead of failing (busy_timeout)', () => {
    const deps = testDeps();
    expect(deps.repo.busyTimeoutMs()).toBeGreaterThanOrEqual(5000);
  });
});

