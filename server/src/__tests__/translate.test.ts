import { createApp } from '../app';
import { costUsd } from '../../../src/translation/costs';
import { testDeps } from './helpers';

const video = { videoId: 'v1', url: 'https://www.youtube.com/watch?v=v1', title: 'LoL', channel: 'ch', description: 'League' };
const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** Fake upstreams: Anthropic Messages API and DeepL. Records every call. */
function fakeUpstreams() {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    calls.push({ url, body, headers });
    if (url.includes('deepl')) {
      return new Response(JSON.stringify({ translations: [{ text: `EN(${body.text[0]})` }] }), { status: 200 });
    }
    const system = (body.system ?? []).map((b: any) => b.text).join('\n');
    const user = body.messages[0].content.map((b: any) => b.text).join('\n');
    const text = system.includes('topicKey')
      ? JSON.stringify({ topic: 'League of Legends', topicKey: 'League of Legends', glossary: [{ source: '뽀삐', target: 'Poppy' }] })
      : JSON.stringify({ translations: [...user.matchAll(/<line id="([^"]+)">/g)].map(m => ({ id: m[1], text: `CLAUDE ${m[1]}` })), glossary: [] });
    return new Response(
      JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: USAGE }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function setup(plan: 'free' | 'standard' | 'pro' = 'standard') {
  const now = { t: Date.UTC(2026, 10, 12, 12) };
  const up = fakeUpstreams();
  const deps = testDeps({ clock: () => now.t, fetch: up.fetchImpl });
  deps.config.deepl.endpoint = 'https://api.deepl.test/v2/translate';
  const app = createApp(deps);
  const account = deps.repo.upsertAccount('sub@example.com');
  if (plan !== 'free') deps.repo.setPlan(account.id, plan, 'active', 'cus_1');
  const token = 'test-token-' + plan;
  deps.repo.addSession(require('../auth').sha256(token), account.id);
  const call = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { now, up, deps, app, account, call, token };
}

const batch = (n = 2, over: Record<string, unknown> = {}) => ({
  sourceLang: 'ko',
  targetLang: 'en',
  lines: Array.from({ length: n }, (_, i) => ({ id: `L${i}`, text: `뽀삐 ${i}`, previous: [], next: [] })),
  video,
  topic: null,
  glossary: [],
  ...over,
});

describe('translation proxy', () => {
  it('a non-subscriber gets 402 not_subscribed', async () => {
    const { call, up } = setup('free');
    const res = await call('/v1/translate/batch', batch());
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('not_subscribed');
    expect((await call('/v1/translate/fast', { text: '안녕', sourceLang: 'ko', targetLang: 'en' })).status).toBe(402);
    expect(up.calls).toHaveLength(0);
  });

  it('a subscriber gets translations and the cost is recorded', async () => {
    const { call, deps, account, up } = setup('standard');
    const res = await call('/v1/translate/batch', batch(2));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ translations: [{ id: 'L0', text: 'CLAUDE L0' }, { id: 'L1', text: 'CLAUDE L1' }], glossaryUpdates: [] });
    expect(up.calls[0].headers['x-api-key']).toBe('sk-ant-service'); // the service's own key, server-side only
    const expected = costUsd({ model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(deps.repo.usageFor(account.id, '2026-11')).toEqual({ costUsd: expected, claudeRequests: 1, fastChars: 0 });
  });

  it('topic summaries go through the proxy and are metered', async () => {
    const { call, deps, account } = setup('pro');
    const res = await call('/v1/translate/topic', { video, firstLines: ['뽀삐 나왔네'], sourceLang: 'ko', targetLang: 'en' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topic: 'League of Legends', topicKey: 'league-of-legends', glossary: [{ source: '뽀삐', target: 'Poppy' }] });
    expect(deps.repo.usageFor(account.id, '2026-11').claudeRequests).toBe(1);
  });

  it('fast translation meters DeepL characters', async () => {
    const { call, deps, account } = setup('standard');
    const res = await call('/v1/translate/fast', { text: '안녕하세요', sourceLang: 'ko', targetLang: 'en', previousLines: ['앞'], nextLines: ['뒤'] });
    expect(await res.json()).toEqual({ text: 'EN(안녕하세요)' });
    const usage = deps.repo.usageFor(account.id, '2026-11');
    expect(usage.fastChars).toBe(5);
    expect(usage.costUsd).toBeCloseTo(5 * 25 / 1_000_000);
  });

  it('at 100 % of the budget both tiers return 402 budget_exhausted and /v1/me reports it', async () => {
    const { call, deps, account, app, token } = setup('standard');
    deps.repo.addUsage(account.id, '2026-11', { costUsd: 6, claudeRequests: 0, fastChars: 0 });
    const res = await call('/v1/translate/batch', batch());
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('budget_exhausted');
    expect((await call('/v1/translate/fast', { text: '안녕', sourceLang: 'ko', targetLang: 'en' })).status).toBe(402);
    const me = await (await app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } })).json();
    expect(me).toMatchObject({ active: true, budgetUsd: 6, exhausted: true, warn: true });
  });

  it('concurrent requests at the edge overshoot by at most the requests in flight; a new month starts at zero', async () => {
    const { call, deps, account, now } = setup('standard');
    deps.repo.addUsage(account.id, '2026-11', { costUsd: 5.995, claudeRequests: 0, fastChars: 0 }); // $0.005 left; each request costs $0.003
    const results = await Promise.all([call('/v1/translate/batch', batch()), call('/v1/translate/batch', batch()), call('/v1/translate/batch', batch())]);
    expect(results.every(r => r.status === 200)).toBe(true);
    const perRequest = costUsd({ model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(deps.repo.usageFor(account.id, '2026-11').costUsd).toBeCloseTo(5.995 + 3 * perRequest);
    expect((await call('/v1/translate/batch', batch())).status).toBe(402);
    now.t = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect((await call('/v1/translate/batch', batch())).status).toBe(200);
  });

  it('oversized or malformed bodies are 400 and never reach upstream', async () => {
    const { call, up } = setup('pro');
    const bad = [
      batch(17),
      batch(1, { lines: [{ id: 'L0', text: 'x'.repeat(501), previous: [], next: [] }] }),
      batch(1, { glossary: Array.from({ length: 201 }, (_, i) => ({ source: `s${i}`, target: 't' })) }),
      batch(1, { lines: [{ id: 'L0', text: 'ok', previous: ['1', '2', '3', '4', '5'], next: [] }] }),
      batch(1, { sourceLang: 42 }),
      'not json',
      JSON.stringify(batch(1, { video: { ...video, description: 'd'.repeat(5_000) } })),
    ];
    for (const body of bad) expect((await call('/v1/translate/batch', body)).status).toBe(400);
    // Over the 64 KB body limit: 413 (refused while reading, see the dedicated test).
    expect((await call('/v1/translate/batch', JSON.stringify(batch(1, { video: { ...video, description: 'd'.repeat(70_000) } })))).status).toBe(413);
    expect((await call('/v1/translate/fast', { text: 'x'.repeat(501), sourceLang: 'ko', targetLang: 'en' })).status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it('standard cannot select Opus (falls back to Sonnet); pro can', async () => {
    const std = setup('standard');
    await std.call('/v1/translate/batch', { ...batch(), model: 'claude-opus-5-5' });
    expect(std.up.calls[0].body.model).toBe('claude-sonnet-5-5');
    const pro = setup('pro');
    await pro.call('/v1/translate/batch', { ...batch(), model: 'claude-opus-5-5' });
    expect(pro.up.calls[0].body.model).toBe('claude-opus-5-5');
    await pro.call('/v1/translate/batch', batch());
    expect(pro.up.calls[1].body.model).toBe('claude-opus-5-5'); // pro default
  });

  it('a lapsed subscription is refused on the next request', async () => {
    const { call, deps, account } = setup('standard');
    deps.repo.setPlan(account.id, 'standard', 'canceled');
    expect((await call('/v1/translate/batch', batch())).status).toBe(402);
  });

  it('Claude and fast requests have their own in-flight caps (4 and 6, matching the extension), refused with 429 beyond', async () => {
    const held = setupHeld();
    const claude = Array.from({ length: 4 }, () => held.call('/v1/translate/batch', batch()));
    const fast = Array.from({ length: 6 }, () => held.call('/v1/translate/fast', { text: '안녕', sourceLang: 'ko', targetLang: 'en' }));
    await new Promise(r => setTimeout(r, 20));
    expect((await held.call('/v1/translate/batch', batch())).status).toBe(429);
    expect((await held.call('/v1/translate/fast', { text: '안녕', sourceLang: 'ko', targetLang: 'en' })).status).toBe(429);
    held.release();
    expect((await Promise.all([...claude, ...fast])).every(r => r.status === 200)).toBe(true);
    expect((await held.call('/v1/translate/batch', batch())).status).toBe(200);
  });

  it('a failed Claude call still charges an estimate of its input cost', async () => {
    const { deps, account, app, token } = setup('standard');
    const failing = createApp({ ...deps, fetch: (async () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529 })) as typeof fetch });
    void app;
    const res = await failing.request('/v1/translate/batch', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(batch(8)) });
    expect(res.status).toBe(502);
    expect(deps.repo.usageFor(account.id, '2026-11').costUsd).toBeGreaterThan(0);
  });

  it('a body over 64 KB is refused before it is read in full', async () => {
    const { app, token, up } = setup('pro');
    const huge = 'x'.repeat(70 * 1024);
    const res = await app.request('/v1/translate/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': String(huge.length) },
      body: huge,
    });
    expect(res.status).toBe(413);
    expect(up.calls).toHaveLength(0);
  });
});

/** A pro account whose upstream calls wait until release() (to hold requests in flight). */
function setupHeld() {
  const now = { t: Date.UTC(2026, 10, 12, 12) };
  const up = fakeUpstreams();
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const held = (async (i: RequestInfo | URL, init?: RequestInit) => {
    await gate;
    return up.fetchImpl(i, init);
  }) as typeof fetch;
  const deps = testDeps({ clock: () => now.t, fetch: held });
  const app = createApp(deps);
  const account = deps.repo.upsertAccount('held@example.com');
  deps.repo.setPlan(account.id, 'pro', 'active', 'cus_h');
  deps.repo.addSession(require('../auth').sha256('held-token'), account.id);
  const call = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer held-token' }, body: JSON.stringify(body) });
  return { call, release: () => release() };
}

