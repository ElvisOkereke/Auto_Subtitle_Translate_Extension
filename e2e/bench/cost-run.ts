// Claude usage for the paid plan ("Best only", Claude Opus 5.5), measured
// through the extension's real translation service: batching, video context,
// topic summary, glossary and prompt caching exactly as a subscriber gets them.
// Reports tokens (by kind) and requests, not dollars: price them with your own
// rates. Lines come from the hand-labelled benchmark videos, fed like read-ahead
// does (a burst for the first 28 s, then each line ~28 s before it appears).
//
//   npx tsx e2e/bench/cost-run.ts [--variant baseline|batch16|context1] [--speed 4] [--only id1,id2]
// Needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) in .env.
// Output: e2e/.perf/cost/<variant>-<time>.json and a summary on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TranslationService, type TranslationServiceDeps } from '../../src/translation/translationService';
import { GlossaryStore } from '../../src/translation/glossary';
import { ClaudeEngine, type ClaudeConfig } from '../../src/translation/engines/claude';
import { DEFAULT_SETTINGS } from '../../src/settings';
import type { Usage, VideoContext } from '../../src/translation/types';

const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const VARIANT = arg('variant', 'baseline');
const SPEED = Number(arg('speed', '4'));
const ONLY = arg('only', '').split(',').filter(Boolean);
const DRY = args.includes('--dry'); // no API calls: a stub Claude (checks the harness)
const LEAD_S = 28; // read-ahead lead
const IMMINENT_S = 10; // lines due sooner go out unbatched (as subtitle mode does)
// windowMs is in real time; the replay runs SPEED times faster, so it is scaled down to match.
const VARIANTS: Record<string, { batch: { maxLines: number; windowMs: number }; context: number; imminentS?: number }> = {
  product: { batch: { maxLines: 16, windowMs: 8000 }, context: 2, imminentS: 14 }, // the product after the cost work
  baseline: { batch: { maxLines: 8, windowMs: 150 }, context: 2 }, // the product before it
  window5s: { batch: { maxLines: 8, windowMs: 5000 }, context: 2 }, // read-ahead lines have ~28 s of slack
  window10s: { batch: { maxLines: 16, windowMs: 10000 }, context: 2 },
  context1: { batch: { maxLines: 8, windowMs: 150 }, context: 1 },
};
const variant = VARIANTS[VARIANT];
if (!variant) throw new Error(`unknown variant ${VARIANT}`);

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .map(l => l.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => [m[1], m[2].replace(/^["']|["']$/g, '')])
);
// The key in .env wins over the shell's (Claude Code's own gateway credentials may be in the environment).
const apiKey = env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const authToken = env.ANTHROPIC_AUTH_TOKEN ?? (apiKey ? undefined : process.env.ANTHROPIC_AUTH_TOKEN);
// Gateway keys (not sk-ant-…) go to the gateway's base URL as a Bearer token.
const gatewayKey = !!apiKey && !apiKey.startsWith('sk-ant-');
const baseURL = env.ANTHROPIC_BASE_URL ?? (gatewayKey || !apiKey ? process.env.ANTHROPIC_BASE_URL : undefined) ?? 'https://api.anthropic.com';
if (!apiKey && !authToken && !DRY) throw new Error('Put ANTHROPIC_API_KEY in .env');
const authStyle = arg('auth', gatewayKey ? 'bearer' : 'x-api-key');
const token = apiKey ?? authToken ?? 'dry';
const auth: ClaudeConfig['auth'] = authToken && !apiKey ? { kind: 'bearer', token } : { kind: authStyle === 'bearer' ? 'bearer' : 'x-api-key', token };

// ---- workload ----------------------------------------------------------------
interface Line { start: number; end: number; text: string }
interface Video { id: string; part: string; mode: 'subtitles' | 'audio'; lang: string; lines: Line[]; context: VideoContext }

function metadata(id: string): { title: string; channel: string; description: string } {
  const file = path.join(ROOT, 'e2e/.cache/video-meta.json');
  const cache: Record<string, { title: string; channel: string; description: string }> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!cache[id]) {
    const ytdlp = path.join(ROOT, 'e2e/.cache/venv/Scripts/yt-dlp.exe');
    const out = execFileSync(ytdlp, ['--skip-download', '--no-warnings', '-J', `https://www.youtube.com/watch?v=${id}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const j = JSON.parse(out);
    cache[id] = { title: j.title ?? '', channel: j.channel ?? j.uploader ?? '', description: j.description ?? '' };
    fs.writeFileSync(file, JSON.stringify(cache, null, 1));
  }
  return cache[id];
}

function workload(): Video[] {
  const bench = JSON.parse(fs.readFileSync(path.join(ROOT, 'e2e/bench/videos.json'), 'utf8')).videos as any[];
  const videos: Video[] = [];
  for (const v of bench) {
    if (ONLY.length && !ONLY.includes(v.id)) continue;
    const meta = DRY ? { title: v.notes ?? v.id, channel: '', description: '' } : metadata(v.id);
    const context = { videoId: v.id, url: `https://www.youtube.com/watch?v=${v.id}`, ...meta };
    const parts: { part: string; lines: Line[] }[] = [];
    if (v.mode === 'audio') {
      const all: Line[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'e2e/fixtures/subtitles', v.reference), 'utf8')).lines.map((l: any) => ({ start: l.start, end: l.end, text: l.text }));
      parts.push({ part: 'window', lines: all.filter(l => l.start >= v.start && l.start < v.start + v.duration) });
    } else {
      // Every labelled stretch of the video: each one a viewing session of the same video.
      const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'e2e/fixtures/subtitles', v.reference), 'utf8'));
      for (const st of ref.stretches) parts.push({ part: st.id, lines: ref.lines.filter((l: any) => l.stretch === st.id).map((l: any) => ({ start: l.start, end: l.end, text: l.ko })) });
    }
    for (const p of parts) {
      if (!p.lines.length) continue;
      p.lines.sort((a, b) => a.start - b.start);
      videos.push({ id: v.id, part: p.part, mode: v.mode, lang: v.lang, lines: p.lines, context });
    }
  }
  return videos;
}

// ---- measurement -------------------------------------------------------------
interface Call { kind: 'batch' | 'topic'; video: string; at: string; lines: number; usage: Usage | null; ms: number }
const calls: Call[] = [];
let currentVideo = '';

function measured(cfg: ClaudeConfig) {
  const fakeUsage = (n: number): Usage => ({ model: 'dry', inputTokens: 100 * n, outputTokens: 20 * n, cacheReadTokens: 1000, cacheWriteTokens: 0 });
  const engine = DRY
    ? ({
        translateBatch: async (req: any) => ({ translations: req.lines.map((l: any) => ({ id: l.id, text: `EN ${l.text}` })), glossaryUpdates: [], usage: fakeUsage(req.lines.length) }),
        summarizeTopic: async () => ({ topic: 'dry topic', topicKey: 'dry', glossary: [], usage: fakeUsage(1) }),
      } as unknown as ClaudeEngine)
    : new ClaudeEngine(cfg);
  return {
    async translateBatch(req: Parameters<ClaudeEngine['translateBatch']>[0]) {
      const t = Date.now();
      const r = await engine.translateBatch(req);
      calls.push({ kind: 'batch', video: currentVideo, at: new Date(t).toISOString(), lines: req.lines.length, usage: r.usage ?? null, ms: Date.now() - t });
      return r;
    },
    async summarizeTopic(...a: Parameters<ClaudeEngine['summarizeTopic']>) {
      const t = Date.now();
      const r = await engine.summarizeTopic(...a);
      calls.push({ kind: 'topic', video: currentVideo, at: new Date(t).toISOString(), lines: 0, usage: r.usage ?? null, ms: Date.now() - t });
      return r;
    },
  };
}

const memory = new Map<string, any>();
const area = {
  get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => memory.has(k)).map(k => [k, memory.get(k)])),
  set: async (items: Record<string, any>) => void Object.entries(items).forEach(([k, v]) => memory.set(k, v)),
  remove: async (keys: string | string[]) => void (Array.isArray(keys) ? keys : [keys]).forEach(k => memory.delete(k)),
};

const failures: string[] = [];
const deps: TranslationServiceDeps = {
  settings: async () => ({ ...DEFAULT_SETTINGS, translationEngineMode: 'best', claudeModel: 'claude-opus-5-5', claudeAccess: 'key', targetLanguage: 'en' }),
  secrets: async () => ({ deeplApiKey: '', googleTranslateApiKey: '', anthropicApiKey: apiKey ?? authToken!, claudeGatewayToken: '', accountToken: '' }),
  overrides: async () => ({ anthropic: baseURL }),
  glossary: new GlossaryStore(area),
  usage: { record: async () => undefined, totals: async () => ({}) as any },
  makeClaude: cfg => measured({ ...cfg, auth }),
  makeFast: () => ({ translateOne: async () => Promise.reject(new Error('fast tier not used in Best only')) }),
  batch: { maxLines: variant.batch.maxLines, windowMs: variant.batch.windowMs / SPEED },
  reportClaudeError: async e => {
    if (e) failures.push(`${e.status ?? ''} ${e.message}`);
  },
};

async function runVideo(service: TranslationService, v: Video): Promise<{ translated: number; lines: number }> {
  currentVideo = v.id;
  const t0 = v.lines[0].start;
  const startedAt = Date.now();
  const sim = () => t0 + ((Date.now() - startedAt) / 1000) * SPEED; // simulated playhead
  void service.prepare(v.context, v.lang); // subtitle mode starts the topic summary at once
  const pending: Promise<boolean>[] = [];
  for (let i = 0; i < v.lines.length; i++) {
    const line = v.lines[i];
    const sendAt = line.start - LEAD_S;
    const wait = ((sendAt - sim()) / SPEED) * 1000;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const priority = line.start - sim() < (variant.imminentS ?? IMMINENT_S) ? 'live' : 'readahead';
    const n = variant.context;
    pending.push(
      service
        .translateLine({
          tier: 'best',
          text: line.text,
          sourceLang: v.lang,
          previousLines: v.lines.slice(Math.max(0, i - n), i).map(l => l.text),
          nextLines: v.lines.slice(i + 1, i + 1 + n).map(l => l.text),
          priority,
          video: v.context,
          noFallback: true,
        })
        .then(r => r.success && r.quality === 'better')
    );
  }
  const ok = await Promise.all(pending);
  return { translated: ok.filter(Boolean).length, lines: v.lines.length };
}

const sum = (cs: Call[], k: keyof Usage) => cs.reduce((a, c) => a + (c.usage ? Number(c.usage[k]) || 0 : 0), 0);

async function main() {
  const videos = workload();
  const service = new TranslationService(deps);
  const started = new Date();
  console.log(`variant ${VARIANT}: ${videos.length} videos, ${videos.reduce((a, v) => a + v.lines.length, 0)} lines, started ${started.toISOString()}`);
  const perVideo: any[] = [];
  for (const v of videos) {
    const before = calls.length;
    const r = await runVideo(service, v);
    const cs = calls.slice(before);
    perVideo.push({ id: v.id, part: v.part, mode: v.mode, lang: v.lang, ...r, requests: cs.length, inputTokens: sum(cs, 'inputTokens'), cacheWriteTokens: sum(cs, 'cacheWriteTokens'), cacheReadTokens: sum(cs, 'cacheReadTokens'), outputTokens: sum(cs, 'outputTokens') });
    console.log(`  ${v.id} ${v.part} (${v.lang}, ${v.mode}): ${r.translated}/${r.lines} lines, ${cs.length} requests`);
  }
  const finished = new Date();
  const lines = perVideo.reduce((a, v) => a + v.lines, 0);
  const totals = {
    requests: calls.length,
    batchRequests: calls.filter(c => c.kind === 'batch').length,
    topicRequests: calls.filter(c => c.kind === 'topic').length,
    inputTokens: sum(calls, 'inputTokens'),
    cacheWriteTokens: sum(calls, 'cacheWriteTokens'),
    cacheReadTokens: sum(calls, 'cacheReadTokens'),
    outputTokens: sum(calls, 'outputTokens'),
  };
  const perLine = Object.fromEntries(Object.entries(totals).filter(([k]) => k.endsWith('Tokens')).map(([k, v]) => [k, v / lines]));
  const perHour = (n: number) => Object.fromEntries(Object.entries(perLine).map(([k, v]) => [k, Math.round(v * n)]));
  const report = {
    variant: VARIANT,
    model: 'claude-opus-5-5',
    mode: 'best only',
    window: { started: started.toISOString(), finished: finished.toISOString() },
    lines,
    translated: perVideo.reduce((a, v) => a + v.translated, 0),
    totals,
    tokensPerLine: perLine,
    tokensPerHour: { busy580: perHour(580), typical400: perHour(400) },
    perVideo,
    failures,
    calls,
  };
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf/cost'), { recursive: true });
  const out = path.join(ROOT, `e2e/.perf/cost/${VARIANT}-${started.toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ window: report.window, lines, translated: report.translated, totals, tokensPerHour: report.tokensPerHour, failures: failures.length }, null, 1));
  console.log(`report: ${path.relative(ROOT, out)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
