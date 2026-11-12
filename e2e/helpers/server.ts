import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { CACHE, FIXTURES } from './paths';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.png': 'image/png',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

export interface TranslationCall {
  provider: 'deepl' | 'google' | 'anthropic';
  text: string;
  target: string;
  source?: string;
  authorization?: string;
  context?: string;
  /** Anthropic mock only. */
  model?: string;
  system?: string;
  xApiKey?: string;
  kind?: 'translate' | 'topic';
}

export interface FixtureServer {
  url: string;
  /** Requests received by the mock translation endpoints (cleared per test). */
  translationCalls: TranslationCall[];
  /** Artificial latency for mock translation responses, in ms. */
  setTranslationDelay: (ms: number) => void;
  /** Make the mock Anthropic API fail with this HTTP status (null = succeed). */
  setAnthropicFailure: (status: number | null) => void;
  close: () => Promise<void>;
}

/**
 * Real-Claude relay for opt-in live tests: the extension is configured with this
 * loopback URL as its "gateway"; the relay forwards to ANTHROPIC_BASE_URL (or
 * api.anthropic.com) and adds the credentials from the environment
 * (ANTHROPIC_AUTH_TOKEN as Bearer, or ANTHROPIC_API_KEY), so they never enter
 * the extension. Responds 404 when no credentials are set.
 */
export const anthropicRelayAvailable = () => !!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

async function relayAnthropic(req: http.IncomingMessage, res: http.ServerResponse, rest: string): Promise<void> {
  if (!anthropicRelayAvailable()) {
    res.statusCode = 404;
    res.end('no Anthropic credentials in the environment');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const h of ['anthropic-version', 'anthropic-beta']) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  else headers['x-api-key'] = process.env.ANTHROPIC_API_KEY!;
  const upstream = await fetch(`${base}${rest}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  res.statusCode = upstream.status;
  res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function serveStream(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    res.end('missing video fixture - run `npm run fixtures:video`');
    return;
  }
  const size = fs.statSync(file).size;
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('accept-ranges', 'bytes');
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  let start = 0;
  let end = size - 1;
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('content-length', String(end - start + 1));
  fs.createReadStream(file, { start, end }).pipe(res);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Serves e2e/fixtures/pages at /, e2e/fixtures/audio at /audio/, and fake
 * DeepL/Google Translate APIs at /mock/deepl and /mock/google (the extension
 * is pointed at them via chrome.storage.local.devEndpointOverrides).
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const translationCalls: TranslationCall[] = [];
  let translationDelay = 0;
  let anthropicFailure: number | null = null;

  // Mock Anthropic Messages API: "[CLAUDE] <line>" per requested line id, a
  // glossary entry for 뽀삐, and a League topic for topic requests.
  const handleAnthropic = (req: http.IncomingMessage, res: http.ServerResponse, body: any) => {
    const system = (body.system ?? []).map((b: any) => b.text ?? '').join('\n');
    const user = (body.messages ?? [])
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : [{ text: m.content }]))
      .map((b: any) => b.text ?? '')
      .join('\n');
    const kind = system.includes('topicKey') ? 'topic' : 'translate';
    translationCalls.push({
      provider: 'anthropic',
      kind,
      text: user,
      target: '',
      model: body.model,
      system,
      authorization: req.headers.authorization,
      xApiKey: req.headers['x-api-key'] as string | undefined,
    });
    if (anthropicFailure) {
      res.statusCode = anthropicFailure;
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'mock failure' } }));
      return;
    }
    let reply: unknown;
    if (kind === 'topic') {
      reply = { topic: 'League of Legends solo queue stream', topicKey: 'League of Legends', glossary: [{ source: '렙차', target: 'level gap' }] };
    } else {
      const lines = [...user.matchAll(/<line id="([^"]+)">[\s\S]*?text: (.*)/g)].map(m => ({ id: m[1], text: m[2].trim() }));
      reply = {
        translations: lines.map(l => ({ id: l.id, text: `[CLAUDE] ${l.text}` })),
        glossary: lines.some(l => l.text.includes('뽀삐')) ? [{ source: '뽀삐', target: 'Poppy', note: 'champion' }] : [],
      };
    }
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(reply) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })
    );
  };

  const handleMock = async (req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) => {
    const body = await readJson(req);
    if (translationDelay) await new Promise(r => setTimeout(r, translationDelay));
    res.setHeader('content-type', 'application/json');
    if (urlPath === '/mock/anthropic/v1/messages') {
      await new Promise(r => setTimeout(r, 400)); // Claude is slower than DeepL: lets tests see fast-then-best
      handleAnthropic(req, res, body);
    } else if (urlPath === '/mock/deepl') {
      const text: string = body.text?.[0] ?? '';
      translationCalls.push({
        provider: 'deepl',
        text,
        target: body.target_lang,
        source: body.source_lang,
        authorization: req.headers.authorization,
        ...(body.context ? { context: body.context } : {}),
      });
      res.end(JSON.stringify({ translations: [{ text: `[${body.target_lang}] ${text}`, detected_source_language: 'FR' }] }));
    } else {
      translationCalls.push({ provider: 'google', text: body.q, target: body.target, source: body.source });
      res.end(
        JSON.stringify({ data: { translations: [{ translatedText: `[${body.target}] ${body.q}`, detectedSourceLanguage: 'fr' }] } })
      );
    }
  };

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (urlPath.startsWith('/relay/anthropic/')) {
      relayAnthropic(req, res, urlPath.slice('/relay/anthropic'.length)).catch(e => {
        res.statusCode = 502;
        res.end(String(e));
      });
      return;
    }
    if (urlPath.startsWith('/mock/')) {
      handleMock(req, res, urlPath).catch(e => {
        res.statusCode = 400;
        res.end(String(e));
      });
      return;
    }
    if (urlPath.startsWith('/videos/')) {
      // Large, gitignored video fixtures (npm run fixtures:video): stream with Range support.
      serveStream(req, res, path.join(CACHE, 'videos', path.basename(urlPath)));
      return;
    }
    if (urlPath.startsWith('/crops/')) {
      // OCR crops exported by e2e/scripts/export_crops.py (gitignored), e.g. /crops/s1/003.png
      const root = path.join(CACHE, 'ocr-crops');
      const file = path.resolve(root, '.' + urlPath.slice('/crops'.length));
      if (!file.startsWith(root + path.sep)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      serveStream(req, res, file);
      return;
    }
    const file = urlPath.startsWith('/audio/')
      ? path.join(FIXTURES, 'audio', path.basename(urlPath))
      : urlPath.startsWith('/subtitles/')
        ? path.join(FIXTURES, 'subtitles', path.basename(urlPath))
        : path.join(FIXTURES, 'pages', path.basename(urlPath) || 'index.html');
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const data = fs.readFileSync(file);
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('accept-ranges', 'bytes');
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : data.length - 1;
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.end(data);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    translationCalls,
    setTranslationDelay: ms => (translationDelay = ms),
    setAnthropicFailure: status => (anthropicFailure = status),
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
