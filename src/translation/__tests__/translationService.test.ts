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
}

function fakes(opts: { settings?: Partial<typeof DEFAULT_SETTINGS>; secrets?: Record<string, string> } = {}): Fakes {
  const area = memoryArea();
  const f = { claudeBatches: [], topicCalls: 0, fastCalls: [], area, claudeConfigs: [] } as unknown as Fakes;
  let failure: Error | null = null;
  let drop = false;
  f.setClaudeFailure = e => (failure = e);
  f.setClaudeDrop = d => (drop = d);
  const deps: TranslationServiceDeps = {
    settings: async () => ({ ...DEFAULT_SETTINGS, translationProvider: 'deepl', ...opts.settings }),
    secrets: async () => ({ deeplApiKey: 'k:fx', googleTranslateApiKey: '', anthropicApiKey: 'sk-ant', claudeGatewayToken: '', ...opts.secrets }),
    overrides: async () => ({}),
    glossary: new GlossaryStore(area),
    usage: new StorageUsageMeter(area),
    makeClaude: cfg => {
      f.claudeConfigs.push(cfg);
      return {
        async translateBatch(req) {
          f.claudeBatches.push(structuredClone(req));
          if (failure) throw failure;
          return {
            translations: drop ? [] : req.lines.map(l => ({ id: l.id, text: `CLAUDE(${l.text})` })),
            glossaryUpdates: req.lines.some(l => l.text.includes('뽀삐')) ? [{ source: '뽀삐', target: 'Poppy' }] : [],
            usage: { model: cfg.model, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        },
        async summarizeTopic() {
          f.topicCalls++;
          await new Promise(r => setTimeout(r, 20));
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
  };
  f.service = new TranslationService(deps);
  return f;
}

describe('TranslationService', () => {
  it('plan reflects mode and configured Claude access', async () => {
    expect(await fakes().service.plan()).toEqual({ fast: true, best: true });
    expect(await fakes({ settings: { translationEngineMode: 'fast' } }).service.plan()).toEqual({ fast: true, best: false });
    expect(await fakes({ settings: { translationEngineMode: 'best' } }).service.plan()).toEqual({ fast: false, best: true });
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
});
