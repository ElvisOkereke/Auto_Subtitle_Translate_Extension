import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { CACHE, FIXTURES } from './paths';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

export interface TranslationCall {
  provider: 'deepl' | 'google';
  text: string;
  target: string;
  source?: string;
  authorization?: string;
}

export interface FixtureServer {
  url: string;
  /** Requests received by the mock translation endpoints (cleared per test). */
  translationCalls: TranslationCall[];
  /** Artificial latency for mock translation responses, in ms. */
  setTranslationDelay: (ms: number) => void;
  close: () => Promise<void>;
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

  const handleMock = async (req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) => {
    const body = await readJson(req);
    if (translationDelay) await new Promise(r => setTimeout(r, translationDelay));
    res.setHeader('content-type', 'application/json');
    if (urlPath === '/mock/deepl') {
      const text: string = body.text?.[0] ?? '';
      translationCalls.push({
        provider: 'deepl',
        text,
        target: body.target_lang,
        source: body.source_lang,
        authorization: req.headers.authorization,
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
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
