/** @jest-environment node */
// Node environment: the engines must run outside the browser too (benchmarks, piece-4 proxy).
import { ClaudeEngine, validateGatewayUrl } from '../engines/claude';
import { DeepLEngine } from '../engines/deepl';
import { GoogleEngine } from '../engines/google';
import type { TranslateBatchRequest } from '../types';

const video = { videoId: 'v', url: 'https://www.youtube.com/watch?v=v', title: 'LoL stream', channel: 'ch', description: 'League' };
const req = (overrides: Partial<TranslateBatchRequest> = {}): TranslateBatchRequest => ({
  sourceLang: 'ko',
  targetLang: 'en',
  lines: [
    { id: 'L1', text: '뽀삐 나왔네', previous: ['아 귀찮다'], next: ['렙차'] },
    { id: 'L2', text: '렙차', previous: ['뽀삐 나왔네'], next: [] },
  ],
  video,
  topic: 'League of Legends',
  glossary: [],
  ...overrides,
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(reply: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const call = { url: String(input), headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const claudeReply = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
});

describe('ClaudeEngine', () => {
  const ok = () =>
    claudeReply('{"translations":[{"id":"L1","text":"Poppy showed up"},{"id":"L2","text":"Level gap"}],"glossary":[{"source":"뽀삐","target":"Poppy"}]}');

  it('sends x-api-key for key access to the configured base URL', async () => {
    const f = fakeFetch(ok);
    const engine = new ClaudeEngine({ model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com', auth: { kind: 'x-api-key', token: 'sk-ant-1' }, fetch: f.fn });
    await engine.translateBatch(req());
    expect(f.calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(f.calls[0].headers['x-api-key']).toBe('sk-ant-1');
    expect(f.calls[0].headers.authorization).toBeUndefined();
    expect(f.calls[0].body.model).toBe('claude-opus-5-5');
    expect(f.calls[0].body.output_config).toEqual({ effort: 'low' });
  });

  it('sends Authorization Bearer for bearer gateways', async () => {
    const f = fakeFetch(ok);
    const engine = new ClaudeEngine({ model: 'claude-sonnet-5-5', baseURL: 'https://gw.example/anthropic', auth: { kind: 'bearer', token: 'tok' }, fetch: f.fn });
    await engine.translateBatch(req());
    expect(f.calls[0].url).toBe('https://gw.example/anthropic/v1/messages');
    expect(f.calls[0].headers.authorization).toBe('Bearer tok');
    expect(f.calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('parses translations, glossary and usage', async () => {
    const f = fakeFetch(ok);
    const engine = new ClaudeEngine({ model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com', auth: { kind: 'x-api-key', token: 'k' }, fetch: f.fn });
    const result = await engine.translateBatch(req());
    expect(result.translations).toEqual([
      { id: 'L1', text: 'Poppy showed up' },
      { id: 'L2', text: 'Level gap' },
    ]);
    expect(result.glossaryUpdates).toEqual([{ source: '뽀삐', target: 'Poppy' }]);
    expect(result.usage).toEqual({ model: 'claude-opus-5-5', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });

  it('summarizeTopic returns topic, normalized topicKey and glossary', async () => {
    const f = fakeFetch(() => claudeReply('{"topic":"League of Legends solo queue stream","topicKey":"League of Legends","glossary":[{"source":"렙차","target":"level gap"}]}'));
    const engine = new ClaudeEngine({ model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com', auth: { kind: 'x-api-key', token: 'k' }, fetch: f.fn });
    const topic = await engine.summarizeTopic(video, ['뽀삐 나왔네'], 'ko', 'en');
    expect(topic).toMatchObject({ topic: 'League of Legends solo queue stream', topicKey: 'league-of-legends', glossary: [{ source: '렙차', target: 'level gap' }] });
    expect(topic.usage?.inputTokens).toBe(1200);
  });

  it('rejects with the HTTP status when Claude fails', async () => {
    const f = fakeFetch(() => ({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }), 401);
    const engine = new ClaudeEngine({ model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com', auth: { kind: 'x-api-key', token: 'k' }, fetch: f.fn });
    await expect(engine.translateBatch(req())).rejects.toMatchObject({ status: 401 });
  });
});

describe('validateGatewayUrl', () => {
  it('accepts https anywhere and http only on loopback', () => {
    expect(validateGatewayUrl('https://gw.example/v1')).toBe('https://gw.example/v1');
    expect(validateGatewayUrl('https://gw.example/v1/')).toBe('https://gw.example/v1');
    expect(validateGatewayUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(validateGatewayUrl('http://localhost:4000/anthropic')).toBe('http://localhost:4000/anthropic');
  });
  it('rejects anything else', () => {
    for (const bad of ['http://example.com', 'gw.example', 'javascript:alert(1)', '', 'ftp://gw.example', 'https://user:pw@gw.example']) {
      expect(validateGatewayUrl(bad)).toBeNull();
    }
  });
});

describe('DeepLEngine', () => {
  const deeplOk = (call: Call) => ({ translations: call.body.text.map((t: string) => ({ text: `EN(${t})` })) });

  it('sends neighbouring lines as context and maps zh-Hans source to ZH', async () => {
    const f = fakeFetch(deeplOk);
    const engine = new DeepLEngine({ apiKey: 'k:fx', fetch: f.fn });
    const result = await engine.translateBatch(req({ sourceLang: 'zh-Hans' }));
    expect(result.translations).toEqual([
      { id: 'L1', text: 'EN(뽀삐 나왔네)' },
      { id: 'L2', text: 'EN(렙차)' },
    ]);
    const first = f.calls.find(c => c.body.text[0] === '뽀삐 나왔네')!;
    expect(first.url).toBe('https://api-free.deepl.com/v2/translate');
    expect(first.headers.authorization).toBe('DeepL-Auth-Key k:fx');
    expect(first.body).toMatchObject({ source_lang: 'ZH', target_lang: 'EN-US', context: '아 귀찮다\n렙차' });
  });

  it('translateBatch keeps at most 4 requests in flight (DeepL rate-limits bursts)', async () => {
    let inFlight = 0;
    let peak = 0;
    const fn = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ translations: [{ text: `EN(${body.text[0]})` }] }), { status: 200 });
    }) as typeof fetch;
    const lines = Array.from({ length: 12 }, (_, i) => ({ id: `L${i}`, text: `t${i}`, previous: [], next: [] }));
    const result = await new DeepLEngine({ apiKey: 'k:fx', fetch: fn }).translateBatch(req({ lines }));
    expect(result.translations.map(t => t.id)).toEqual(lines.map(l => l.id));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('uses an endpoint override when given (dev mock)', async () => {
    const f = fakeFetch(deeplOk);
    await new DeepLEngine({ apiKey: 'pro-key', endpoint: 'http://127.0.0.1:9/mock/deepl', fetch: f.fn }).translateBatch(req());
    expect(f.calls[0].url).toBe('http://127.0.0.1:9/mock/deepl');
  });
});

describe('GoogleEngine', () => {
  it('translates each line with the Google API key', async () => {
    const f = fakeFetch(call => ({ data: { translations: [{ translatedText: `EN(${call.body.q})` }] } }));
    const result = await new GoogleEngine({ apiKey: 'g', fetch: f.fn }).translateBatch(req({ sourceLang: 'zh-Hant' }));
    expect(result.translations.map(t => t.text)).toEqual(['EN(뽀삐 나왔네)', 'EN(렙차)']);
    expect(f.calls[0].url).toContain('key=g');
    expect(f.calls[0].body).toMatchObject({ source: 'zh-TW', target: 'en', format: 'text' });
  });
});
