import { APIError } from '../../types';
import { GlossaryStore, StorageArea } from '../glossary';
import { LineTranslateRequest, StorageUsageMeter, TranslationService, TranslationServiceDeps } from '../translationService';
import type { TranslateBatchRequest } from '../types';
import { DEFAULT_SETTINGS } from '../../settings';

function memoryArea(): StorageArea & { data: Record<string, any> } {
  const data: Record<string, any> = {};
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
  };
}

const video = { videoId: 'vid1', url: 'https://www.youtube.com/watch?v=vid1', title: 'LoL stream', channel: 'ch', description: 'League' };
const request = (over: Partial<LineTranslateRequest> = {}): LineTranslateRequest => ({
  tier: 'best',
  text: '뽀삐 나왔네',
  sourceLang: 'ko',
  previousLines: [],
  nextLines: [],
  priority: 'live',
  video,
  ...over,
});

interface Fakes {
  service: TranslationService;
  claudeBatches: TranslateBatchRequest[];
  topicCalls: number;
  fastCalls: string[];
  area: ReturnType<typeof memoryArea>;
  claudeConfigs: any[];
  setClaudeFailure(e: Error | null): void;
  setClaudeDrop(ids: boolean): void;
  /** Drop this many lines from replies, once each (model skipping ids). */
  dropOnce(texts: string[]): void;
  errors: (unknown)[];
  now: { t: number };
}

function fakes(opts: { settings?: Partial<typeof DEFAULT_SETTINGS>; secrets?: Record<string, string>; topicMs?: number; claudeMs?: number } = {}): Fakes {
  const area = memoryArea();
  const f = { claudeBatches: [], topicCalls: 0, fastCalls: [], area, claudeConfigs: [] } as unknown as Fakes;
  let failure: Error | null = null;
  let drop = false;
  let dropTexts = new Set<string>();
  f.setClaudeFailure = e => (failure = e);
  f.setClaudeDrop = d => (drop = d);
  f.dropOnce = texts => (dropTexts = new Set(texts));
  f.errors = [];
  f.now = { t: 1_000_000 };
  const deps: TranslationServiceDeps = {
    settings: async () => ({ ...DEFAULT_SETTINGS, translationProvider: 'deepl', ...opts.settings }),
    secrets: async () => ({ deeplApiKey: 'k:fx', googleTranslateApiKey: '', anthropicApiKey: 'sk-ant', claudeGatewayToken: '', accountToken: '', ...opts.secrets }),
    overrides: async () => ({ server: 'http://127.0.0.1:9' }), // a hosted service is configured (dev override)
    glossary: new GlossaryStore(area),
    usage: new StorageUsageMeter(area),
    makeClaude: cfg => {
      f.claudeConfigs.push(cfg);
      return {
        async translateBatch(req) {
          f.claudeBatches.push(structuredClone(req));
          if (opts.claudeMs) await new Promise(r => setTimeout(r, opts.claudeMs));
          if (failure) throw failure;
          return {
            translations: drop
              ? []
              : req.lines.filter(l => !dropTexts.delete(l.text)).map(l => ({ id: l.id, text: `CLAUDE(${l.text})` })),
            glossaryUpdates: req.lines.some(l => l.text.includes('뽀삐')) ? [{ source: '뽀삐', target: 'Poppy' }] : [],
            usage: { model: cfg.model, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        },
        async summarizeTopic() {
          f.topicCalls++;
          await new Promise(r => setTimeout(r, opts.topicMs ?? 20));
          return { topic: 'League of Legends stream', topicKey: 'league-of-legends', glossary: [{ source: '렙차', target: 'level gap' }] };
        },
      };
    },
    makeFast: () => ({
      async translateOne(text: string) {
        f.fastCalls.push(text);
        return { text: `DEEPL(${text})` };
      },
    }),
    batch: { maxLines: 8, windowMs: 20 },
    topicWaitMs: 100,
    reportClaudeError: async e => {
      f.errors.push(e);
    },
    clock: () => f.now.t,
  };
  f.service = new TranslationService(deps);
  return f;
}

describe('TranslationService', () => {
  it('plan reflects mode and configured Claude access', async () => {
    expect(await fakes().service.plan()).toEqual({ fast: true, best: true });
    expect(await fakes({ settings: { translationEngineMode: 'fast' } }).service.plan()).toEqual({ fast: true, best: false });
    expect(await fakes({ settings: { translationEngineMode: 'best' } }).service.plan()).toEqual({ fast: false, best: true });
    // Best only without Claude access falls back to the fast engine (subtitles must not disappear).
    expect(await fakes({ settings: { translationEngineMode: 'best' }, secrets: { anthropicApiKey: '' } }).service.plan()).toEqual({ fast: true, best: false });
    expect(await fakes({ secrets: { anthropicApiKey: '' } }).service.plan()).toEqual({ fast: true, best: false });
    const gatewayNoToken = fakes({ settings: { claudeAccess: 'gateway', claudeGatewayUrl: 'https://gw.example' }, secrets: { anthropicApiKey: '' } });
    expect(await gatewayNoToken.service.plan()).toEqual({ fast: true, best: false });
    const gatewayBadUrl = fakes({ settings: { claudeAccess: 'gateway', claudeGatewayUrl: 'http://gw.example' }, secrets: { claudeGatewayToken: 't' } });
    expect(await gatewayBadUrl.service.plan()).toEqual({ fast: true, best: false });
  });

  it('fast tier uses the fast engine; best tier uses Claude with topic and glossary', async () => {
    const f = fakes();
    expect(await f.service.translateLine(request({ tier: 'fast' }))).toEqual({ success: true, translatedText: 'DEEPL(뽀삐 나왔네)', quality: 'fast', engine: 'deepl' });
    const best = await f.service.translateLine(request());
    expect(best).toEqual({ success: true, translatedText: 'CLAUDE(뽀삐 나왔네)', quality: 'better', engine: 'claude' });
    expect(f.claudeBatches[0]).toMatchObject({ topic: 'League of Legends stream', video, sourceLang: 'ko', targetLang: 'en' });
    expect(f.claudeBatches[0].glossary).toEqual([{ source: '렙차', target: 'level gap' }]); // from the topic step
  });

  it('builds the Claude engine from key or gateway settings', async () => {
    const key = fakes({ settings: { claudeModel: 'claude-sonnet-5-5' } });
    await key.service.translateLine(request());
    expect(key.claudeConfigs[0]).toMatchObject({ model: 'claude-sonnet-5-5', baseURL: 'https://api.anthropic.com', auth: { kind: 'x-api-key', token: 'sk-ant' } });
    const gw = fakes({ settings: { claudeAccess: 'gateway', claudeGatewayUrl: 'https://gw.example/anthropic/', claudeGatewayAuth: 'bearer' }, secrets: { claudeGatewayToken: 'tok' } });
    await gw.service.translateLine(request());
    expect(gw.claudeConfigs[0]).toMatchObject({ baseURL: 'https://gw.example/anthropic', auth: { kind: 'bearer', token: 'tok' } });
  });

  it('the topic is summarised once per video even with concurrent requests', async () => {
    const f = fakes();
    await Promise.all([f.service.translateLine(request()), f.service.translateLine(request({ text: '렙차', priority: 'readahead' }))]);
    await f.service.translateLine(request({ text: '또 뽀삐' }));
    expect(f.topicCalls).toBe(1);
  });

  it('read-ahead lines are batched; a live line is not held for the batch window', async () => {
    const f = fakes();
    await f.service.translateLine(request({ text: 'warm-up' })); // topic step done
    f.claudeBatches.length = 0;
    await Promise.all(['a', 'b', 'c'].map(t => f.service.translateLine(request({ text: t, priority: 'readahead' }))));
    expect(f.claudeBatches.map(b => b.lines.length)).toEqual([3]);
    await f.service.translateLine(request({ text: 'live one' }));
    expect(f.claudeBatches[1].lines.map(l => l.text)).toEqual(['live one']);
  });

  it('Claude failure falls back to the fast engine; with no fast key the line fails', async () => {
    const f = fakes();
    f.setClaudeFailure(new APIError('rate limited', 429));
    expect(await f.service.translateLine(request())).toEqual({ success: true, translatedText: 'DEEPL(뽀삐 나왔네)', quality: 'fast', engine: 'deepl' });
    const noFast = fakes({ secrets: { deeplApiKey: '' } });
    noFast.setClaudeFailure(new APIError('rate limited', 429));
    const r = await noFast.service.translateLine(request());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/rate limited|Claude/);
  });

  it('a 401 from Claude is reported once, then falls back quietly', async () => {
    const f = fakes();
    f.setClaudeFailure(new APIError('authentication_error', 401));
    const first = await f.service.translateLine(request());
    expect(first.warning).toMatch(/Claude rejected/);
    expect(first.translatedText).toBe('DEEPL(뽀삐 나왔네)');
    const second = await f.service.translateLine(request({ text: '렙차' }));
    expect(second.warning).toBeUndefined();
  });

  it('missing translations in a Claude reply fall back per line', async () => {
    const f = fakes();
    f.setClaudeDrop(true);
    expect(await f.service.translateLine(request())).toMatchObject({ translatedText: 'DEEPL(뽀삐 나왔네)', quality: 'fast' });
  });

  it('glossary updates from replies are learned and sent with the next request', async () => {
    const f = fakes();
    await f.service.translateLine(request());
    await f.service.translateLine(request({ text: '렙차 났다' }));
    expect(f.claudeBatches[1].glossary).toContainEqual({ source: '뽀삐', target: 'Poppy' });
  });

  it('usage is recorded with cost', async () => {
    const f = fakes();
    await f.service.translateLine(request());
    const totals = await new StorageUsageMeter(f.area).totals();
    expect(totals.lines).toBe(1);
    expect(totals.costUsd).toBeCloseTo((1000 * 4 + 50 * 20) / 1e6);
    expect(totals.byModel['claude-opus-5-5'].requests).toBe(1);
  });

  it('same source and target language returns the text unchanged', async () => {
    const f = fakes({ settings: { targetLanguage: 'ko' } });
    expect(await f.service.translateLine(request())).toMatchObject({ success: true, translatedText: '뽀삐 나왔네' });
    expect(f.claudeBatches).toHaveLength(0);
  });

  it('a slow topic summary does not hold lines back; later lines get the topic', async () => {
    const f = fakes({ topicMs: 400 });
    const t0 = Date.now();
    const first = await f.service.translateLine(request());
    expect(Date.now() - t0).toBeLessThan(300); // waited at most topicWaitMs (100 ms), not 400
    expect(first.engine).toBe('claude');
    expect(f.claudeBatches[0].topic).toBeNull();
    await new Promise(r => setTimeout(r, 400));
    await f.service.translateLine(request({ text: '렙차' }));
    expect(f.claudeBatches[1].topic).toBe('League of Legends stream');
    expect(f.topicCalls).toBe(1);
  });

  it('fast-tier lines are not queued behind slow Claude requests', async () => {
    const f = fakes({ claudeMs: 300 });
    await f.service.translateLine(request({ text: 'warm-up' }));
    const claude = Array.from({ length: 6 }, (_, i) => f.service.translateLine(request({ text: `live ${i}` })));
    const t0 = Date.now();
    const fast = await f.service.translateLine(request({ tier: 'fast', text: '빠른 줄' }));
    expect(fast.engine).toBe('deepl');
    expect(Date.now() - t0).toBeLessThan(100);
    await Promise.all(claude);
  });

  it('prepare() summarises the topic from the page before any line arrives', async () => {
    const f = fakes();
    await f.service.prepare(video, 'ko');
    expect(f.topicCalls).toBe(1);
    await f.service.translateLine(request());
    expect(f.topicCalls).toBe(1);
    expect(f.claudeBatches[0].topic).toBe('League of Legends stream');
  });

  it('a line Claude skipped in a batch is retried once on its own', async () => {
    const f = fakes();
    await f.service.translateLine(request({ text: 'warm-up' }));
    f.dropOnce(['b']);
    const results = await Promise.all(['a', 'b', 'c'].map(t => f.service.translateLine(request({ text: t, priority: 'readahead' }))));
    expect(results.map(r => r.translatedText)).toEqual(['CLAUDE(a)', 'CLAUDE(b)', 'CLAUDE(c)']);
    expect(f.claudeBatches[f.claudeBatches.length - 1].lines.map(l => l.text)).toEqual(['b']);
  });

  it('noFallback: a best request whose caller already asked for the fast tier is not translated twice by DeepL', async () => {
    const f = fakes();
    f.setClaudeFailure(new APIError('overloaded', 529));
    const r = await f.service.translateLine(request({ noFallback: true }));
    expect(r.success).toBe(false);
    expect(f.fastCalls).toEqual([]);
  });

  it('after a 429/5xx Claude is skipped for a cooldown; after a 401 until the settings change', async () => {
    const f = fakes();
    await f.service.translateLine(request({ text: 'warm-up' }));
    f.setClaudeFailure(new APIError('rate limited', 429));
    await f.service.translateLine(request({ text: 'a' }));
    const calls = f.claudeBatches.length;
    await f.service.translateLine(request({ text: 'b' }));
    expect(f.claudeBatches.length).toBe(calls); // cooling down: no new Claude call
    f.setClaudeFailure(null);
    f.now.t += 31_000;
    expect((await f.service.translateLine(request({ text: 'c' }))).engine).toBe('claude');

    const g = fakes();
    await g.service.translateLine(request({ text: 'warm-up' }));
    g.setClaudeFailure(new APIError('bad key', 401));
    await g.service.translateLine(request({ text: 'a' }));
    const after401 = g.claudeBatches.length;
    g.now.t += 600_000;
    await g.service.translateLine(request({ text: 'b' }));
    expect(g.claudeBatches.length).toBe(after401); // still the same bad key: not retried
  });

  it('Claude errors are reported (for the popup) and cleared after a success', async () => {
    const f = fakes();
    f.setClaudeFailure(new APIError('bad key', 401));
    await f.service.translateLine(request());
    expect(f.errors[f.errors.length - 1]).toMatchObject({ status: 401 });
    f.setClaudeFailure(null);
    f.now.t += 600_000;
    await (f.service as any).deps.settings().then(() => undefined);
    (f.service as any).brokenConfig = null; // as if the key was fixed in the popup
    await f.service.translateLine(request({ text: '렙차' }));
    expect(f.errors[f.errors.length - 1]).toBeNull();
    const ok = fakes();
    await ok.service.translateLine(request());
    expect(ok.errors).toEqual([]); // nothing to clear: no write
  });

  it('a failed topic summary is not retried on every line', async () => {
    const f = fakes();
    let topicFailures = 0;
    (f.service as any).deps.makeClaude = ((orig: any) => (cfg: any) => {
      const e = orig(cfg);
      return { ...e, translateBatch: e.translateBatch, summarizeTopic: async () => { topicFailures++; throw new APIError('overloaded', 529); } };
    })((f.service as any).deps.makeClaude);
    for (const t of ['a', 'b', 'c']) await f.service.translateLine(request({ text: t, sourceLang: 'ko' }));
    expect(topicFailures).toBe(1);
  });

  it('storage errors while recording glossary or usage never throw away a translation', async () => {
    const f = fakes();
    (f.service as any).deps.glossary.learn = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    (f.service as any).deps.usage.record = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    expect(await f.service.translateLine(request())).toMatchObject({ engine: 'claude', translatedText: 'CLAUDE(뽀삐 나왔네)' });
  });

  it('subscription access uses the proxy (Claude and fast tier) and needs only an account token', async () => {
    const f = fakes({
      settings: { claudeAccess: 'subscription', translationProvider: 'subscription' },
      secrets: { anthropicApiKey: '', deeplApiKey: '', accountToken: 'acct-token' },
    });
    expect(await f.service.plan()).toEqual({ fast: true, best: true });
    await f.service.translateLine(request());
    expect(f.claudeConfigs[0]).toMatchObject({ via: 'proxy', auth: { kind: 'bearer', token: 'acct-token' } });
    const fast = await f.service.translateLine(request({ tier: 'fast', text: '빠른' }));
    expect(fast).toMatchObject({ success: true, engine: 'subscription' });
    const signedOut = fakes({ settings: { claudeAccess: 'subscription', translationProvider: 'subscription' }, secrets: { anthropicApiKey: '', deeplApiKey: '' } });
    expect(await signedOut.service.plan()).toEqual({ fast: true, best: false });
  });

  it('a 402 from the proxy (budget used up / not subscribed) pauses Claude for 10 minutes', async () => {
    const f = fakes({ settings: { claudeAccess: 'subscription' }, secrets: { accountToken: 'acct-token' } });
    await f.service.translateLine(request({ text: 'warm-up' }));
    f.setClaudeFailure(Object.assign(new Error('used up'), { status: 402, code: 'budget_exhausted' }));
    await f.service.translateLine(request({ text: 'a' }));
    const calls = f.claudeBatches.length;
    f.now.t += 5 * 60_000;
    await f.service.translateLine(request({ text: 'b' }));
    expect(f.claudeBatches.length).toBe(calls);
    f.setClaudeFailure(null);
    f.now.t += 6 * 60_000;
    expect((await f.service.translateLine(request({ text: 'c' }))).engine).toBe('claude');
  });

  it('a proxy bad_request (400) or rate_limited (429) does not switch Claude off', async () => {
    const f = fakes({ settings: { claudeAccess: 'subscription' }, secrets: { accountToken: 'acct-token' } });
    await f.service.translateLine(request({ text: 'warm-up' }));
    f.setClaudeFailure(Object.assign(new Error('bad'), { status: 400, code: 'bad_request' }));
    await f.service.translateLine(request({ text: 'a' }));
    f.setClaudeFailure(Object.assign(new Error('busy'), { status: 429, code: 'rate_limited' }));
    await f.service.translateLine(request({ text: 'b' }));
    f.setClaudeFailure(null);
    expect((await f.service.translateLine(request({ text: 'c' }))).engine).toBe('claude'); // no config error, no cooldown
  });

  it('subscription access is unavailable while no hosted service is configured', async () => {
    const f = fakes({ settings: { claudeAccess: 'subscription' }, secrets: { accountToken: 'acct-token' } });
    (f.service as any).deps.overrides = async () => ({}); // no dev server, placeholder default
    expect(await f.service.plan()).toEqual({ fast: true, best: false });
  });

  it('a live line waits less for a slow topic summary than a read-ahead line does', async () => {
    const f = fakes({ topicMs: 2000 });
    (f.service as any).deps.topicWaitMs = undefined; // product defaults
    const t0 = Date.now();
    await f.service.translateLine(request({ priority: 'live' }));
    const live = Date.now() - t0;
    expect(live).toBeLessThan(900); // <= 0.5 s head start for the topic
    const g = fakes({ topicMs: 2000 });
    (g.service as any).deps.topicWaitMs = undefined;
    const t1 = Date.now();
    await g.service.translateLine(request({ priority: 'readahead' }));
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1400); // read-ahead lines are early anyway: 1.5 s for the topic
  });
});

