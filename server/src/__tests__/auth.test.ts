import { createHash } from 'node:crypto';
import { createApp } from '../app';
import { OutboxMailer } from '../mailer';
import { testDeps } from './helpers';

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function setup() {
  const now = { t: Date.UTC(2026, 10, 12, 12) };
  const mailer = new OutboxMailer();
  const deps = testDeps({ mailer, clock: () => now.t });
  const app = createApp(deps);
  const lastCode = (email: string) => mailer.sent.filter(m => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];
  const signIn = async (email: string) => {
    await post(app, '/v1/auth/start', { email });
    const res = await post(app, '/v1/auth/verify', { email, code: lastCode(email) });
    return (await res.json()).token as string;
  };
  return { now, mailer, deps, app, lastCode, signIn };
}

describe('accounts', () => {
  it('sign-in: start emails a 6-digit code, verify returns a token that authenticates /v1/me', async () => {
    const { app, mailer, lastCode } = setup();
    expect((await post(app, '/v1/auth/start', { email: 'Fan@Example.com' })).status).toBe(200);
    expect(mailer.sent[0].to).toBe('fan@example.com');
    const res = await post(app, '/v1/auth/verify', { email: 'fan@example.com', code: lastCode('fan@example.com') });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token).toMatch(/^[\w-]{40,}$/);
    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'fan@example.com', plan: 'free', active: false, usageUsd: 0, budgetUsd: 0 });
  });

  it('a code works once and expires after 10 minutes', async () => {
    const { app, now, lastCode } = setup();
    await post(app, '/v1/auth/start', { email: 'a@example.com' });
    const code = lastCode('a@example.com');
    expect((await post(app, '/v1/auth/verify', { email: 'a@example.com', code })).status).toBe(200);
    expect((await post(app, '/v1/auth/verify', { email: 'a@example.com', code })).status).toBe(400);
    await post(app, '/v1/auth/start', { email: 'a@example.com' });
    const second = lastCode('a@example.com');
    now.t += 10 * 60_000 + 1;
    expect((await post(app, '/v1/auth/verify', { email: 'a@example.com', code: second })).status).toBe(400);
  });

  it('5 wrong attempts kill the code', async () => {
    const { app, lastCode } = setup();
    await post(app, '/v1/auth/start', { email: 'a@example.com' });
    const code = lastCode('a@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await post(app, '/v1/auth/verify', { email: 'a@example.com', code: wrong })).status).toBe(400);
    expect((await post(app, '/v1/auth/verify', { email: 'a@example.com', code })).status).toBe(400);
  });

  it('more than 3 codes per email per 15 minutes is rate limited (429), and per IP after 20 per hour', async () => {
    const { app, now } = setup();
    for (let i = 0; i < 3; i++) expect((await post(app, '/v1/auth/start', { email: 'a@example.com' })).status).toBe(200);
    expect((await post(app, '/v1/auth/start', { email: 'a@example.com' })).status).toBe(429);
    now.t += 15 * 60_000 + 1;
    expect((await post(app, '/v1/auth/start', { email: 'a@example.com' })).status).toBe(200);
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 20; i++) expect((await post(app, '/v1/auth/start', { email: `u${i}@example.com` }, ip)).status).toBe(200);
    expect((await post(app, '/v1/auth/start', { email: 'u99@example.com' }, ip)).status).toBe(429);
  });

  it('rejects malformed emails', async () => {
    const { app } = setup();
    for (const email of ['', 'not-an-email', 'a@b', `${'x'.repeat(300)}@example.com`, 42]) {
      expect((await post(app, '/v1/auth/start', { email })).status).toBe(400);
    }
  });

  it('signout revokes the token (401 after)', async () => {
    const { app, signIn } = setup();
    const token = await signIn('a@example.com');
    expect((await post(app, '/v1/auth/signout', {}, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('tokens and codes are stored hashed', async () => {
    const { deps, signIn, mailer } = setup();
    const token = await signIn('a@example.com');
    const code = mailer.sent[0].text.match(/\b(\d{6})\b/)![1];
    const stored = [...deps.repo.allCodeHashes(), ...deps.repo.allSessionHashes()].join(' ');
    expect(stored).not.toContain(token);
    expect(stored).not.toMatch(new RegExp(`\\b${code}\\b`));
    expect(deps.repo.allSessionHashes()).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('/v1/me without or with a bad token is 401', async () => {
    const { app } = setup();
    expect((await app.request('/v1/me')).status).toBe(401);
    expect((await app.request('/v1/me', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('the dev outbox is only served when DEV_OUTBOX is on', async () => {
    const on = setup();
    await post(on.app, '/v1/auth/start', { email: 'a@example.com' });
    const res = await on.app.request('/dev/outbox?email=a@example.com');
    expect(res.status).toBe(200);
    expect((await res.json()).messages[0].text).toMatch(/\d{6}/);
    const off = createApp(testDeps({ mailer: new OutboxMailer(), config: { ...testDeps().config, devOutbox: false } }));
    expect((await off.request('/dev/outbox?email=a@example.com')).status).toBe(404);
  });
});
