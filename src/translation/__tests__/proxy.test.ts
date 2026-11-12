/** @jest-environment node */
import { ProxyClient, ProxyError, proxyClaude, proxyFast } from '../engines/proxy';

const video = { videoId: 'v', url: 'https://www.youtube.com/watch?v=v', title: 't', channel: 'c', description: 'd' };

function fakeFetch(reply: (path: string, body: any) => { status?: number; json: unknown }) {
  const calls: { path: string; body: any; auth?: string }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers as HeadersInit).get('authorization') ?? undefined });
    const r = reply(url.pathname, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('ProxyClient', () => {
  it('sends the bearer token and maps 402 budget_exhausted to an error with status 402', async () => {
    const f = fakeFetch(() => ({ status: 402, json: { error: 'budget_exhausted', message: 'used up' } }));
    const client = new ProxyClient({ baseURL: 'http://127.0.0.1:9', token: 'tok', fetch: f.fn });
    const error = await client.translateOne('안녕', 'ko', 'en', {}).catch(e => e);
    expect(error).toBeInstanceOf(ProxyError);
    expect(error).toMatchObject({ status: 402, code: 'budget_exhausted' });
    expect(f.calls[0]).toMatchObject({ path: '/v1/translate/fast', auth: 'Bearer tok' });
  });

  it('translateBatch / summarizeTopic / translateOne call the proxy paths with the model', async () => {
    const f = fakeFetch(path =>
      path === '/v1/translate/batch'
        ? { json: { translations: [{ id: 'L1', text: 'hi' }], glossaryUpdates: [] } }
        : path === '/v1/translate/topic'
          ? { json: { topic: 'T', topicKey: 't', glossary: [] } }
          : { json: { text: 'hello' } }
    );
    const client = new ProxyClient({ baseURL: 'http://127.0.0.1:9/', token: 'tok', fetch: f.fn });
    const claude = proxyClaude(client, 'claude-sonnet-5-5');
    const req = { sourceLang: 'ko', targetLang: 'en', lines: [{ id: 'L1', text: '안녕', previous: [], next: [] }], video, topic: null, glossary: [] };
    expect(await claude.translateBatch(req)).toEqual({ translations: [{ id: 'L1', text: 'hi' }], glossaryUpdates: [] });
    expect(await claude.summarizeTopic(video, ['안녕'], 'ko', 'en')).toEqual({ topic: 'T', topicKey: 't', glossary: [] });
    expect(await proxyFast(client).translateOne('안녕', 'ko', 'en', { previousLines: ['a'] })).toEqual({ text: 'hello' });
    expect(f.calls.map(c => c.path)).toEqual(['/v1/translate/batch', '/v1/translate/topic', '/v1/translate/fast']);
    expect(f.calls[0].body).toMatchObject({ ...req, model: 'claude-sonnet-5-5' });
    expect(f.calls[2].body).toMatchObject({ text: '안녕', sourceLang: 'ko', targetLang: 'en', previousLines: ['a'] });
  });

  it('account calls: start, verify (returns the token), me, checkout/portal URLs, signout', async () => {
    const f = fakeFetch(path => {
      if (path === '/v1/auth/verify') return { json: { token: 'new-token' } };
      if (path === '/v1/billing/checkout') return { json: { url: 'https://checkout.stripe.com/c/1' } };
      if (path === '/v1/billing/portal') return { json: { url: 'https://billing.stripe.com/p/1' } };
      if (path === '/v1/me') return { json: { email: 'a@b.co', plan: 'pro', active: true } };
      return { json: { ok: true } };
    });
    const anon = new ProxyClient({ baseURL: 'http://127.0.0.1:9', fetch: f.fn });
    await anon.start('a@b.co');
    expect(await anon.verify('a@b.co', '123456')).toBe('new-token');
    expect(f.calls[0].auth).toBeUndefined();
    const client = new ProxyClient({ baseURL: 'http://127.0.0.1:9', token: 'new-token', fetch: f.fn });
    expect(await client.me()).toMatchObject({ plan: 'pro' });
    expect(await client.checkout('pro')).toBe('https://checkout.stripe.com/c/1');
    expect(await client.portal()).toBe('https://billing.stripe.com/p/1');
    await client.signout();
    expect(f.calls[f.calls.length - 1]).toMatchObject({ path: '/v1/auth/signout', auth: 'Bearer new-token' });
  });

  it('network failures become ProxyError status 0', async () => {
    const client = new ProxyClient({ baseURL: 'http://127.0.0.1:9', token: 't', fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    await expect(client.me()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('trims requests to the server limits (text 500 chars, 4 neighbours each, video fields)', async () => {
    const f = fakeFetch(() => ({ json: { translations: [], glossaryUpdates: [] } }));
    const client = new ProxyClient({ baseURL: 'http://127.0.0.1:9', token: 't', fetch: f.fn });
    const long = 'x'.repeat(800);
    await client.translateBatch(
      {
        sourceLang: 'ko',
        targetLang: 'en',
        lines: [{ id: 'L1', text: long, previous: [long, 'a', 'b', 'c', 'd', 'e'], next: ['n'] }],
        video: { ...video, url: 'https://x.example/' + 'p'.repeat(3000), description: 'd'.repeat(5000) },
        topic: 't'.repeat(400),
        glossary: Array.from({ length: 250 }, (_, i) => ({ source: `s${i}`, target: 't' })),
      },
      'claude-sonnet-5-5'
    );
    const body = f.calls[0].body;
    expect(body.lines[0].text).toHaveLength(500);
    expect(body.lines[0].previous).toEqual(['b', 'c', 'd', 'e']); // the 4 nearest
    expect(body.video.url.length).toBeLessThanOrEqual(2000);
    expect(body.video.description.length).toBeLessThanOrEqual(2000);
    expect(body.topic.length).toBeLessThanOrEqual(300);
    expect(body.glossary).toHaveLength(200);
  });

  it('long text (e.g. a Screen Translate paragraph) is split into chunks of at most 500 characters and joined', async () => {
    const f = fakeFetch((_p, body) => ({ json: { text: `T${body.text.length}` } }));
    const client = new ProxyClient({ baseURL: 'http://127.0.0.1:9', token: 't', fetch: f.fn });
    const sentence = 'This is a sentence of about forty chars. ';
    const text = sentence.repeat(30); // ~1200 chars
    const result = await client.translateOne(text.trim(), 'en', 'fr');
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.calls.every(c => c.body.text.length <= 500)).toBe(true);
    expect(result.text.split(' ').length).toBe(f.calls.length);
  });
});
