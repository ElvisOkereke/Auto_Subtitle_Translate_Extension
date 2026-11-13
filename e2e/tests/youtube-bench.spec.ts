import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import Anthropic from '@anthropic-ai/sdk';
import { browserKind } from '../helpers/launch';
import { readEnv } from '../helpers/env';
import { anthropicRelayAvailable, type FixtureServer } from '../helpers/server';
import { astTest } from '../helpers/bridge';
import { dragBox, modeStats, recordOverlay, shownRecords, type ModeStats } from '../helpers/subtitles';
import { recordSourceBufferTypes, sourceBufferTypes, waitOutAds } from '../helpers/youtube';
import { benchVideos, referenceLines, referenceStretch, type BenchVideo } from '../bench/videos';
import {
  coverageByDuration,
  matchLines,
  missBuckets,
  missesBySize,
  readyBeforeShown,
  shownWhilePaused,
  timeOnScreen,
  upgradesOnScreen,
  type ShownRecord,
} from '../bench/metrics';

// Benchmark of subtitle mode (spec 2026-11-13): the fixed video set in
// e2e/bench/videos.json, on real YouTube (installed Chrome, visible window,
// signed-in test profile) and on local copies of the same windows (both
// containers). Real engines: DeepL (DEEPL_API_KEY in .env) and Claude through
// the fixture server's relay (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL), in each
// engine mode listed in BENCH_MODES (default: fast-then-best). Accuracy and
// timing are scored on the Korean source the extension read for each shown
// line; BENCH_JUDGE=1 adds Claude's quality score of the translations.
// Reports: e2e/.perf/youtube-bench/<label>/<run>-<mode>-<id>.json.
// Hard assertions: nothing appears while paused; on real YouTube the
// read-ahead path carries a tapped format. Everything else is recorded.

const LABEL = process.env.BENCH_LABEL || execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
/** Video SourceBuffer formats the read-ahead tap reads (mseTap.main.ts). */
const TAPPED = /^video\/mp4/i;
const OUT = path.join(ROOT, 'e2e/.perf/youtube-bench', LABEL);
const PAUSE_AFTER_S = 60;
const PAUSE_WALL_MS = 5000;
const subtitleVideos = benchVideos.filter(v => v.mode === 'subtitles' && v.reference);
type EngineMode = 'fast' | 'best' | 'fast-then-best';
const MODES = (process.env.BENCH_MODES || 'fast-then-best').split(',').map(m => m.trim()) as EngineMode[];
const DEEPL_KEY = readEnv('DEEPL_API_KEY');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
const JUDGE_INSTRUCTIONS =
  'Score each English subtitle translation of a Korean League of Legends video subtitle. ' +
  'Use 2 = correct and natural (League terms right), 1 = gist right but a notable error, 0 = wrong or misleading. ' +
  'A reference, when given, is one good translation, not the only acceptable one. ' +
  'Reply with only a JSON array of integers, one per item, in order.';

/** Real engines in the given mode (Claude through the fixture server's relay). */
function engineSettings(mode: EngineMode, server: FixtureServer) {
  return {
    translationProvider: 'deepl',
    deeplApiKey: DEEPL_KEY,
    translationEngineMode: mode,
    claudeModel: CLAUDE_MODEL,
    claudeAccess: 'gateway',
    claudeGatewayUrl: `${server.url}/relay/anthropic`,
    claudeGatewayToken: 'relay',
    claudeGatewayAuth: 'bearer',
    targetLanguage: 'en',
  };
}

/** Claude's 0..1 quality score of the shown translations (BENCH_JUDGE=1; costs money). */
async function judge(pairs: { ko: string; en: string; reference?: string }[]): Promise<number | null> {
  if (process.env.BENCH_JUDGE !== '1' || !pairs.length) return null;
  const items = pairs.map((p, i) => `${i + 1}. Korean: ${p.ko}\n   Reference: ${p.reference ?? '(none)'}\n   Candidate: ${p.en}`).join('\n');
  const response = await new Anthropic().messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: JUDGE_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: items, cache_control: { type: 'ephemeral' } }] }],
  } as any);
  const text = (response as any).content.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('');
  const scores = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as number[];
  return scores.length === pairs.length ? scores.reduce((a, b) => a + b, 0) / (2 * scores.length) : null;
}

interface TimelineEntry {
  start: number;
  end: number | null;
  source: string;
  translation: string | null;
  quality: string;
  translatedAt: number | null;
  betterAt: number | null;
}

interface RunResult {
  records: ShownRecord[];
  stats: ModeStats;
  timeline: TimelineEntry[];
  played: number; // seconds of the window that played
  blocked: string | null;
  format: string | null;
}

async function report(run: string, mode: EngineMode, video: BenchVideo, r: RunResult) {
  const windowEnd = video.start + Math.min(video.duration, r.played);
  const ref = referenceLines(video).filter(l => l.start >= video.start + 1 && l.end <= windowEnd - 1);
  // Score what was read: each shown line carries the Korean source of its timeline entry.
  const sourceAt = (lineStart: number) => r.timeline.find(t => Math.abs(t.start - lineStart) < 0.002)?.source;
  const matches = matchLines(ref, r.records.map(s => ({ ...s, text: sourceAt(s.lineStart) ?? '' })));
  const matched = matches.filter(m => m.shown && m.cer !== null);
  const cer = matched.length ? matched.reduce((sum, m) => sum + m.cer!, 0) / matched.length : null;
  const { linesFromReadAhead: ra, linesFromLive: live } = r.stats;
  const total = ra + live;
  const pathUsed = !total ? 'none' : ra / total > 0.9 ? 'read-ahead' : live / total > 0.9 ? 'live' : 'mixed';
  const offsets = matched.map(m => m.shown!.lineStart - m.ref.start).sort((a, b) => a - b);
  // Lines not ready in time: how long after the subtitle appeared the translation showed.
  const waits = matched.map(m => m.shown!.shownAt - m.ref.start).filter(w => w > 0.05).sort((a, b) => a - b);
  const entryFor = (line: { start: number; end: number }) => r.timeline.find(t => t.start >= line.start - 0.6 && t.start <= line.end);
  const claudeReady = ref.filter(l => {
    const e = entryFor(l);
    return e?.betterAt !== null && e?.betterAt !== undefined && e.betterAt < l.start;
  }).length;
  const pairs = matched.flatMap(m => {
    const e = entryFor(m.ref);
    return e?.translation ? [{ ko: m.ref.ko, en: e.translation, reference: m.ref.en }] : [];
  });
  const out = {
    id: video.id,
    run,
    mode,
    label: LABEL,
    path: pathUsed,
    format: r.format,
    played: r.played,
    blocked: r.blocked,
    lines: ref.length,
    coverage: coverageByDuration(matches),
    missBuckets: missBuckets(matches),
    missesBySize: missesBySize(matches),
    misses: matches.filter(m => !m.shown).map(m => `${m.ref.start.toFixed(2)}-${m.ref.end.toFixed(2)} ${m.ref.ko}`),
    readyBeforeShown: readyBeforeShown(r.timeline, ref),
    claudeReadyBeforeShown: ref.length ? claudeReady / ref.length : null,
    waitP50: waits.length ? waits[Math.floor(waits.length / 2)] : 0,
    waitP90: waits.length ? waits[Math.floor(waits.length * 0.9)] : 0,
    upgradesOnScreen: upgradesOnScreen(r.records),
    judgeScore: await judge(pairs),
    sample: pairs.slice(0, 5),
    displayOffsetP50: offsets.length ? offsets[Math.floor(offsets.length / 2)] : null,
    timeOnScreen: timeOnScreen(r.records),
    shownWhilePaused: shownWhilePaused(r.records),
    ocrCer: cer,
    stats: r.stats,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${run}-${mode}-${video.id}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, misses: out.misses.length, stats: undefined, sample: undefined }));
  return out;
}

/** Plays the window with one pause, polling for YouTube's player error. */
async function playWindow(page: Page, video: BenchVideo, toLocal: (t: number) => number): Promise<{ played: number; blocked: string | null }> {
  const end = toLocal(video.start + video.duration);
  const pauseAt = toLocal(video.start + PAUSE_AFTER_S);
  const begin = toLocal(video.start);
  let paused = false;
  let last = begin;
  await page.evaluate(() => document.querySelector('video')!.play());
  for (;;) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => {
      const v = document.querySelector('video')!;
      return { t: v.currentTime, ad: !!document.querySelector('#movie_player.ad-showing'), error: document.querySelector('.ytp-error')?.textContent?.trim() ?? null };
    });
    if (s.error) return { played: last - begin, blocked: s.error };
    if (s.ad) await waitOutAds(page);
    last = s.t;
    if (!paused && s.t >= pauseAt) {
      paused = true;
      await page.evaluate(() => document.querySelector('video')!.pause());
      await page.waitForTimeout(PAUSE_WALL_MS);
      await page.evaluate(() => document.querySelector('video')!.play());
    }
    if (s.t >= end) return { played: video.duration, blocked: null };
  }
}

async function collect(page: Page, toAbsolute: (t: number) => number) {
  const records = (await shownRecords(page)).map(r => ({
    ...r,
    shownAt: toAbsolute(r.shownAt),
    lineStart: toAbsolute(r.lineStart),
    hiddenAt: r.hiddenAt === null ? null : toAbsolute(r.hiddenAt),
  }));
  const stats = await modeStats(page);
  const timeline = (await astTest<TimelineEntry[]>(page, 'mode.timeline')).map(t => ({
    ...t,
    start: toAbsolute(t.start),
    end: t.end === null ? null : toAbsolute(t.end),
    translatedAt: t.translatedAt === null ? null : toAbsolute(t.translatedAt),
    betterAt: t.betterAt === null ? null : toAbsolute(t.betterAt),
  }));
  return { records, stats, timeline };
}

async function startSubtitleMode(page: Page, openPopup: (p: Page) => Promise<Page>, video: BenchVideo) {
  const popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.selectOption('#subtitleLanguage', video.lang);
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragBox(page, video.box);
  await expect.poll(async () => (await modeStats(page)).state, { timeout: 120_000 }).toBe('running');
}

test.use({ mockTranslation: false });
test.skip(!DEEPL_KEY, 'DEEPL_API_KEY not set in .env');
test.skip(!anthropicRelayAvailable(), 'no Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)');

test.describe('real YouTube', () => {
  test.use({ profileDir: path.join(CACHE, 'profile-youtube'), headed: true });
  test.skip(browserKind() !== 'chrome', 'real YouTube runs use installed Chrome (E2E_BROWSER=chrome)');

  for (const mode of MODES) for (const video of subtitleVideos) {
    test(`benchmark ${video.id} [${mode}]`, async ({ context, openPopup, configure, sw, server }) => {
      await configure({ ...engineSettings(mode, server), subtitleLanguage: video.lang });
      await sw.evaluate(() => chrome.storage.local.remove('devSubtitle'));
      const page = await context.newPage();
      await recordSourceBufferTypes(page);
      await page.goto(`https://www.youtube.com/watch?v=${video.id}&t=${video.start}s`);
      await page.waitForSelector('video.html5-main-video', { timeout: 30_000 });
      await waitOutAds(page);
      await page.evaluate(start => {
        (document.getElementById('movie_player') as any)?.setPlaybackQualityRange?.('hd1080', 'hd1080');
        const v = document.querySelector('video.html5-main-video') as HTMLVideoElement;
        v.pause();
        v.currentTime = start;
      }, video.start);
      await recordOverlay(page);
      await astTest(page, 'timeline.clear');
      await startSubtitleMode(page, openPopup, video);
      const { played, blocked } = await playWindow(page, video, t => t);
      const format = (await sourceBufferTypes(page)).find(m => m.startsWith('video/')) ?? null;
      const out = await report('youtube', mode, video, { ...(await collect(page, t => t)), played, blocked, format });

      expect(out.shownWhilePaused, 'lines appeared while the video was paused').toBe(0);
      if (!blocked && format && TAPPED.test(format)) expect(out.path, `read-ahead should carry ${format}`).not.toBe('live');
      if (blocked) console.warn(`YouTube stopped playback after ${played.toFixed(0)} s: ${blocked}`);
    });
  }
});

test.describe('local copies', () => {
  for (const mode of MODES) for (const container of ['mp4', 'webm'] as const) {
    for (const video of subtitleVideos) {
      test(`benchmark ${video.id} (${container}) [${mode}]`, async ({ context, fixtureURL, openPopup, configure, server }) => {
        const stretch = referenceStretch(video);
        const fileId = stretch.file.split('.')[0];
        const file = path.join(CACHE, 'videos', `${fileId}.${stretch.id}.video.${container}`);
        test.skip(!fs.existsSync(file), `${file} missing: npm run fixtures:video`);
        await configure({ ...engineSettings(mode, server), subtitleLanguage: video.lang });
        const page = await context.newPage();
        await recordSourceBufferTypes(page);
        await page.goto(`${fixtureURL}/video-subs.html?v=${video.id}&file=${fileId}&stretch=${stretch.id}&container=${container}`);
        await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
        await astTest(page, 'timeline.clear');
        await recordOverlay(page);
        const toLocal = (t: number) => t - stretch.start;
        const toAbsolute = (t: number) => t + stretch.start;
        await page.evaluate(t => {
          const v = document.querySelector('video')!;
          v.pause();
          v.currentTime = t;
        }, toLocal(video.start));
        await startSubtitleMode(page, openPopup, video);
        const { played, blocked } = await playWindow(page, video, toLocal);
        const format = (await sourceBufferTypes(page)).find(m => m.startsWith('video/')) ?? null;
        const out = await report(`local-${container}`, mode, video, { ...(await collect(page, toAbsolute)), played, blocked, format });
        expect(out.shownWhilePaused, 'lines appeared while the video was paused').toBe(0);
      });
    }
  }
});
