import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect, keepPage } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import Anthropic from '@anthropic-ai/sdk';
import { browserKind } from '../helpers/launch';
import { readEnv } from '../helpers/env';
import { anthropicRelayAvailable, type FixtureServer } from '../helpers/server';
import { astTest } from '../helpers/bridge';
import { clearTranslationState, dragBox, modeStats, recordOverlay, recordOverlayOnEveryLoad, shownRecords, type ModeStats } from '../helpers/subtitles';
import { recordSourceBufferTypes, sourceBufferTypes, waitOutAds } from '../helpers/youtube';
import { benchVideos, cutOffset, referenceLines, referenceStretch, type BenchVideo } from '../bench/videos';
import { recordCaptions, recordCaptionsOnEveryLoad, shownCaptions, waitForSpeechModel, type CaptionRecord } from '../helpers/captions';
import {
  coverageByDuration,
  matchLines,
  classifyMisses,
  captionDelays,
  transcriptCer,
  wordsCovered,
  speechCovered,
  captionStartOffsets,
  missBuckets,
  missesBySize,
  readyBeforeShown,
  shownWhilePaused,
  staleWhilePaused,
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
const TAPPED = /^video\/(mp4|webm)/i;
const OUT = path.join(ROOT, 'e2e/.perf/youtube-bench', LABEL);
const PAUSE_AFTER_S = 60;
const PAUSE_WALL_MS = 5000;
const subtitleVideos = benchVideos.filter(v => v.mode === 'subtitles' && v.reference);
type EngineMode = 'fast' | 'best' | 'fast-then-best';
const MODES = (process.env.BENCH_MODES || 'fast-then-best').split(',').map(m => m.trim()) as EngineMode[];
const DEEPL_KEY = readEnv('DEEPL_API_KEY');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
const JUDGE_INSTRUCTIONS =
  'Score each English translation of a video subtitle (the video is described first). ' +
  'Use 2 = correct and natural (names and domain terms right), 1 = gist right but a notable error, 0 = wrong or misleading. ' +
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
async function judge(video: BenchVideo, pairs: { ko: string; en: string; reference?: string }[]): Promise<number | null> {
  if (process.env.BENCH_JUDGE !== '1' || !pairs.length) return null;
  const items =
    `Video: ${video.notes ?? video.id} (subtitle language: ${video.lang})\n\n` +
    pairs.map((p, i) => `${i + 1}. Source: ${p.ko}\n   Reference: ${p.reference ?? '(none)'}\n   Candidate: ${p.en}`).join('\n');
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
  /** Real YouTube: where one sliding window handed over to the next (absolute seconds). */
  joins?: number[];
  /** Real YouTube: share of playback polls that found the playing window hidden. */
  windowHidden?: number;
  /** Real YouTube: distinct video heights seen while playing. */
  videoHeights?: number[];
  translationErrors?: { count: number; samples: string[] };
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
  // The timeline entry a shown line actually came from (not just any entry in its window).
  const entryOf = (m: (typeof matches)[number]) => (m.shown ? r.timeline.find(t => Math.abs(t.start - m.shown!.lineStart) < 0.002) : undefined);
  const claudeReady = matches.filter(m => {
    const e = entryOf(m);
    return e?.betterAt !== null && e?.betterAt !== undefined && e.betterAt < m.ref.start;
  }).length;
  const pairs = matched.flatMap(m => {
    const e = entryOf(m);
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
    missCauses: classifyMisses(matches, r.timeline, r.records),
    readyBeforeShown: readyBeforeShown(r.timeline, ref, matches),
    claudeReadyBeforeShown: ref.length ? claudeReady / ref.length : null,
    waitP50: waits.length ? waits[Math.floor(waits.length / 2)] : 0,
    waitP90: waits.length ? waits[Math.floor(waits.length * 0.9)] : 0,
    upgradesOnScreen: upgradesOnScreen(r.records),
    judgeScore: await judge(video, pairs),
    sample: pairs.slice(0, 5),
    displayOffsetP50: offsets.length ? offsets[Math.floor(offsets.length / 2)] : null,
    timeOnScreen: timeOnScreen(r.records),
    shownWhilePaused: shownWhilePaused(r.records),
    staleWhilePaused: staleWhilePaused(r.records, r.timeline),
    pausedLines: r.records.filter(x => x.pausedAtShow).map(x => ({ lineStart: x.lineStart, shownAt: x.shownAt, text: x.text, source: sourceAt(x.lineStart) ?? null })),
    joins: r.joins ?? [],
    windowHidden: r.windowHidden ?? null,
    videoHeights: r.videoHeights ?? null,
    translationErrors: r.translationErrors ?? null,
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
  await play(page);
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
      await play(page);
    }
    if (s.t >= end) return { played: video.duration, blocked: null };
  }
}

async function collect(page: Page, toAbsolute: (t: number) => number) {
  const records = ((await shownRecords(page)) ?? []).map(r => ({
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

/** Waits until the video has frames and its on-screen rect stops moving (the page is still laying out while it loads). */
async function waitForSettledPlayer(page: Page): Promise<void> {
  let last = '';
  let stable = 0;
  const deadline = Date.now() + 30_000;
  while (stable < 4 && Date.now() < deadline) {
    const now = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v || v.readyState < 2) return 'loading';
      const r = v.getBoundingClientRect();
      return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
    });
    stable = now !== 'loading' && now === last ? stable + 1 : 0;
    last = now;
    await page.waitForTimeout(250);
  }
}

/** The box the extension saved for this page's video (normalized), if any. */
async function savedBox(page: Page, sw: { evaluate: Function }): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const videoKey = await page.evaluate(() => {
    const u = new URL(location.href);
    return u.hostname.endsWith('youtube.com') ? u.searchParams.get('v') : `${u.origin}${u.pathname}?v=${encodeURIComponent(u.searchParams.get('v') ?? '')}`;
  });
  return (await (sw.evaluate as any)((key: string) => chrome.storage.local.get(key).then(r => r[key] ?? null), `subtitleBox:${videoKey}`)) as any;
}

async function startSubtitleMode(page: Page, openPopup: (p: Page) => Promise<Page>, video: BenchVideo): Promise<Page> {
  await waitForSettledPlayer(page);
  const popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.selectOption('#subtitleLanguage', video.lang);
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragBox(page, video.box);
  await expect.poll(async () => (await modeStats(page)).state, { timeout: 120_000 }).toBe('running');
  return popup;
}

/** Draws the box, then checks the saved box matches the intended one (redraws once if the layout moved). */
async function startSubtitleModeChecked(page: Page, openPopup: (p: Page) => Promise<Page>, video: BenchVideo, sw: { evaluate: Function }): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const popup = await startSubtitleMode(page, openPopup, video);
    await popup.close();
    await page.bringToFront();
    const saved = await savedBox(page, sw);
    const want = video.box!;
    const off = saved ? Math.max(Math.abs(saved.x - want.x), Math.abs(saved.y - want.y), Math.abs(saved.w - want.w), Math.abs(saved.h - want.h)) : 1;
    if (off <= 0.02) return;
    console.warn(`saved box off by ${off.toFixed(3)} (${JSON.stringify(saved)}), redrawing`);
  }
  throw new Error('the subtitle box could not be drawn in the intended place');
}

test.use({ mockTranslation: false, reuseBrowser: true });
test.skip(!DEEPL_KEY, 'DEEPL_API_KEY not set in .env');
test.skip(!anthropicRelayAvailable(), 'no Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)');

// Real YouTube stops automated playback after ~40 s of a page's playback, so the
// window is played as a sliding window: 30 s pieces, each in its own browser
// window opened at its timestamp. While one plays, the next is prepared (loaded,
// ads waited out, paused at its start, subtitle mode running with the saved box,
// read-ahead already reading). Windows sit side by side: Chrome stops presenting
// frames in covered windows. Each window scores only the lines of its own piece.
const SEGMENT_S = 30;

/** Translation failures logged by the content script ("Subtitle translation failed: ..."), per run. */
let translationErrors: string[] = [];
const watchConsole = (page: Page) =>
  page.on('console', m => {
    const text = m.text();
    if (/Subtitle translation failed|Read-ahead OCR failed|Claude/.test(text)) translationErrors.push(text.slice(0, 200));
  });

const SLOT_W = 1280;
const SLOT_H = 720;
const slots = new WeakMap<BrowserContext, Page[]>();

/**
 * The window for a piece: two windows per worker, side by side, kept for the
 * whole run (the next piece navigates the window's tab). Worker N uses row N
 * of a grid on the main screen so parallel workers never cover each other.
 */
async function slotPage(context: BrowserContext, slot: number, row: number): Promise<Page> {
  const pages = slots.get(context) ?? [];
  slots.set(context, pages);
  if (pages[slot] && !pages[slot].isClosed()) return pages[slot];
  const cdp = await context.browser()!.newBrowserCDPSession();
  const opened = context.waitForEvent('page');
  const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })) as { targetId: string };
  const page = await opened;
  const { windowId } = (await cdp.send('Browser.getWindowForTarget', { targetId })) as { windowId: number };
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: slot * SLOT_W, top: row * SLOT_H, width: SLOT_W, height: SLOT_H, windowState: 'normal' } });
  await cdp.detach();
  keepPage(page);
  watchConsole(page);
  pages[slot] = page;
  return page;
}

/**
 * Starts playback without waiting for play()'s promise: it never settles when
 * playback can't start (YouTube buffering for good, or swapping the source),
 * which hung whole runs. The polling loops watch progress instead.
 */
async function play(page: Page): Promise<void> {
  await page.waitForSelector('video', { timeout: 30_000 });
  await page.evaluate(() => {
    document.querySelector('video')!.play().catch(() => undefined);
  });
}

/** Seconds without progress before play is re-issued, and before a piece counts as stalled. */
const NUDGE_AFTER_S = 15;
const STALLED_AFTER_S = 60;

async function parkAt(page: Page, t: number): Promise<void> {
  await page.waitForSelector('video.html5-main-video', { timeout: 30_000 });
  await waitOutAds(page);
  await page.evaluate(at => {
    const player = document.getElementById('movie_player') as any;
    player?.setPlaybackQualityRange?.('hd1080', 'hd1080');
    // YouTube remembers 'muted' per profile and re-applies it over the video element;
    // a muted tab captures silence (Audio mode), so unmute through the player.
    player?.unMute?.();
    player?.setVolume?.(100);
    // YouTube may play an auto-dubbed track (e.g. English TTS over Japanese commentary):
    // always the original language's own audio.
    const tracks: any[] = player?.getAvailableAudioTracks?.() ?? [];
    const isOriginal = (t: any) => Object.values(t ?? {}).some((x: any) => x && typeof x === 'object' && x.isAutoDubbed === false && /original/i.test(String(x.name ?? '')));
    const original = tracks.find(isOriginal);
    if (original && !isOriginal(player.getAudioTrack?.())) player.setAudioTrack(original);
    const v = document.querySelector('video.html5-main-video') as HTMLVideoElement;
    v.pause();
    v.currentTime = at;
  }, t);
}

/** Plays one piece [from, to); pauses PAUSE_WALL_MS once when it passes pauseAt. */
/** Polls of a playing window that found it hidden (covered or in the background): frames stop there. */
let hiddenPolls = 0;
let playPolls = 0;
/** Pieces whose prepared window had moved off the piece's start (re-seeked before playing). */
let reparks = 0;
/** Video heights seen while playing (YouTube may lower the quality). */
let heights: number[] = [];

async function playSegment(page: Page, from: number, to: number, pauseAt: number): Promise<{ played: number; blocked: string | null }> {
  let paused = !(pauseAt >= from && pauseAt < to);
  let last = from;
  let progressAt = Date.now();
  await page.bringToFront();
  await page.waitForSelector('video.html5-main-video', { timeout: 30_000 });
  // A window prepared ahead may have been resumed by YouTube while it waited: back to the piece's start.
  const moved = await page.evaluate(at => {
    const v = document.querySelector('video')!;
    if (Math.abs(v.currentTime - at) <= 1) return false;
    v.currentTime = at;
    return true;
  }, from);
  if (moved) reparks++;
  await play(page);
  for (;;) {
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => {
      const v = document.querySelector('video')!;
      return { t: v.currentTime, h: v.videoHeight, hidden: document.visibilityState !== 'visible', ad: !!document.querySelector('#movie_player.ad-showing'), error: document.querySelector('.ytp-error')?.textContent?.trim() ?? null };
    });
    playPolls++;
    heights.push(st.h);
    if (st.hidden) hiddenPolls++;
    if (st.error) return { played: last - from, blocked: st.error };
    if (st.ad) await waitOutAds(page);
    if (st.t > last + 0.1) progressAt = Date.now();
    const still = (Date.now() - progressAt) / 1000;
    if (still > STALLED_AFTER_S) return { played: Math.max(0, last - from), blocked: `stalled at ${last.toFixed(1)} s` };
    if (still > NUDGE_AFTER_S && Math.floor(still) % NUDGE_AFTER_S === 0) await play(page);
    last = st.t;
    if (!paused && st.t >= pauseAt) {
      paused = true;
      await page.evaluate(() => document.querySelector('video')!.pause());
      await page.waitForTimeout(PAUSE_WALL_MS);
      await play(page);
      progressAt = Date.now();
    }
    if (st.t >= to) {
      await page.evaluate(() => document.querySelector('video')!.pause());
      return { played: to - from, blocked: null };
    }
  }
}

function sumStats(all: ModeStats[]): ModeStats {
  const out = { ...all[0] } as any;
  for (const key of Object.keys(out)) if (typeof out[key] === 'number') out[key] = all.reduce((n, s: any) => n + (s[key] ?? 0), 0);
  return out;
}

test.describe('real YouTube', () => {
  test.use({ profileDir: path.join(CACHE, 'profile-youtube'), headed: true });
  test.skip(browserKind() !== 'chrome', 'real YouTube runs use installed Chrome (E2E_BROWSER=chrome)');

  for (const mode of MODES) for (const video of subtitleVideos) {
    test(`benchmark ${video.id} [${mode}]`, async ({ context, openPopup, configure, sw, server, tabIdOf }, testInfo) => {
      test.setTimeout(900_000);
      await configure({ ...engineSettings(mode, server), subtitleLanguage: video.lang });
      await sw.evaluate(() => chrome.storage.local.remove('devSubtitle'));
      await clearTranslationState(sw); // no glossary or topic summary carried over from an earlier run
      const row = testInfo.parallelIndex % 2;
      await recordSourceBufferTypes(context);
      await recordOverlayOnEveryLoad(context);
      const pieces = Math.ceil(video.duration / SEGMENT_S);
      const from = (k: number) => video.start + k * SEGMENT_S;
      const to = (k: number) => Math.min(video.start + video.duration, from(k + 1));
      const url = (k: number) => `https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(from(k))}s`;

      const retries: string[] = [];
      // A window whose subtitle mode doesn't start (seen intermittently) is reopened once.
      const prepare = async (k: number): Promise<Page> => {
        try {
          return await prepareOnce(k);
        } catch (error) {
          retries.push(`piece ${k}: ${String(error).split(/\r?\n/)[0].slice(0, 120)}`);
          return prepareOnce(k);
        }
      };
      const prepareOnce = async (k: number): Promise<Page> => {
        const page = await slotPage(context, k % 2, row);
        await page.goto(url(k));
        await parkAt(page, from(k));
        if (k === 0) {
          await astTest(page, 'timeline.clear');
          await startSubtitleModeChecked(page, openPopup, video, sw);
        } else {
          const tabId = await tabIdOf(page);
          await expect
            .poll(async () => {
              const r = await sw.evaluate(id => chrome.tabs.sendMessage(id, { type: 'START_SUBTITLE_MODE' }).catch(e => ({ success: false, error: String(e) })), tabId);
              return (r as any)?.success === true || (await modeStats(page)).state === 'running';
            }, { timeout: 60_000 })
            .toBe(true);
        }
        await expect.poll(async () => (await modeStats(page)).state, { timeout: 120_000 }).toBe('running');
        return page;
      };

      hiddenPolls = 0;
      playPolls = 0;
      reparks = 0;
      heights = [];
      translationErrors = [];
      const records: ShownRecord[] = [];
      const timeline = new Map<number, TimelineEntry>();
      const stats: ModeStats[] = [];
      const joins: number[] = [];
      const blocks: string[] = [];
      let played = 0;
      let format: string | null = null;
      let page = await prepare(0);
      let pending: Promise<Page> | null = pieces > 1 ? prepare(1) : null;
      for (let k = 0; k < pieces; k++) {
        const r = await playSegment(page, from(k), to(k), video.start + PAUSE_AFTER_S);
        played += r.played;
        if (r.blocked) blocks.push(`${from(k) + r.played}: ${r.blocked}`);
        const got = await collect(page, t => t);
        records.push(...got.records.filter(x => x.shownAt >= from(k) && x.shownAt < to(k)));
        for (const e of got.timeline) {
          const key = Math.round(e.start * 1000);
          const known = timeline.get(key);
          if (!known || (!known.translation && e.translation) || (known.quality !== 'better' && e.quality === 'better')) timeline.set(key, e);
        }
        stats.push(got.stats);
        format ??= (await sourceBufferTypes(page)).find(m => m.startsWith('video/')) ?? null;
        if (k + 1 < pieces) {
          const next = await pending!;
          joins.push(to(k));
          await page.goto('about:blank'); // stop this piece's playback and mode; the window stays
          page = next;
          pending = k + 2 < pieces ? prepare(k + 2) : null;
        }
      }
      await page.goto('about:blank');
      const out = await report('youtube', mode, video, {
        records: records.sort((a, b) => a.shownAt - b.shownAt),
        stats: sumStats(stats),
        timeline: [...timeline.values()].sort((a, b) => a.start - b.start),
        played,
        blocked: blocks.length ? blocks.join('; ') : null,
        format,
        joins,
        windowHidden: playPolls ? hiddenPolls / playPolls : 0,
        reparks,
        videoHeights: [...new Set(heights)].sort((a, b) => a - b),
        translationErrors: { count: translationErrors.length, samples: [...new Set(translationErrors)].slice(0, 5) },
      });
      if (retries.length) console.warn(`window setup retried: ${retries.join('; ')}`);

      expect(out.staleWhilePaused, 'a line that was not on screen appeared while the video was paused').toBe(0);
      if (format && TAPPED.test(format)) expect(out.path, `read-ahead should carry ${format}`).not.toBe('live');
      if (blocks.length) console.warn(`YouTube stopped playback in ${blocks.length} piece(s): ${blocks.join('; ')}`);
    });
  }
});

test.describe('local copies', () => {
  for (const mode of MODES) for (const container of ['mp4', 'webm'] as const) {
    for (const video of subtitleVideos) {
      test(`benchmark ${video.id} (${container}) [${mode}]`, async ({ context, fixtureURL, openPopup, configure, server, sw }) => {
        const stretch = referenceStretch(video);
        const fileId = stretch.file.split('.')[0];
        const file = path.join(CACHE, 'videos', `${fileId}.${stretch.id}.video.${container}`);
        test.skip(!fs.existsSync(file), `${file} missing: npm run fixtures:video`);
        await configure({ ...engineSettings(mode, server), subtitleLanguage: video.lang });
        await clearTranslationState(sw);
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
        expect(out.staleWhilePaused, 'a line that was not on screen appeared while the video was paused').toBe(0);
      });
    }
  }
});

// ---- Audio mode (live captions from the tab's sound) ----

const audioVideos = benchVideos.filter(v => v.mode === 'audio' && v.reference);

/** Seconds an audio piece plays past its end so the last phrase's caption can arrive. */
const CAPTION_TAIL_S = 4;

/** Turns Audio mode on in a tab (what the popup's Start live captions does). */
async function startAudioMode(sw: Worker, page: Page, tabIdOf: (p: Page) => Promise<number>): Promise<void> {
  const tabId = await tabIdOf(page);
  await expect
    .poll(
      async () => {
        const state = (await sw.evaluate(id => chrome.tabs.sendMessage(id, { type: 'GET_SUBTITLE_STATE' }).catch(() => null), tabId)) as any;
        if (state?.active) return true;
        await sw.evaluate(id => chrome.tabs.sendMessage(id, { type: 'TOGGLE_SUBTITLES' }).catch(() => null), tabId);
        return false;
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] }
    )
    .toBe(true);
}

async function audioReport(run: string, mode: EngineMode, video: BenchVideo, captions: CaptionRecord[], played: number, extra: Record<string, unknown> = {}) {
  const window: [number, number] = [video.start, video.start + Math.min(video.duration, played)];
  const ref = referenceLines(video).filter(l => l.start >= window[0] && l.end <= window[1]);
  const delays = captionDelays(ref, captions);
  const pairs = captions.filter(c => c.source && c.text && c.text !== c.source).slice(0, 40).map(c => ({ ko: c.source, en: c.text }));
  const out = {
    id: video.id,
    run,
    mode,
    label: LABEL,
    kind: 'audio',
    played,
    captions: captions.length,
    referenceLines: ref.length,
    transcriptCer: transcriptCer(ref, captions, window),
    wordsCovered: wordsCovered(ref, captions),
    // What a viewer sees: share of talking time with a caption on screen, longest talking stretch without one.
    onScreenWhileTalking: speechCovered(ref, captions, window).share,
    longestGapWhileTalking: speechCovered(ref, captions, window).longestGap,
    // Read-ahead: how far each caption's appearance is from its words' start (target within 0.5 s).
    startOffset: captionStartOffsets(ref, captions),
    readAheadCaptions: captions.filter(c => typeof c.videoStart === 'number').length,
    delayFromSpeechEndP50: delays.fromSpeechEndP50,
    delayFromSpeechEndP90: delays.fromSpeechEndP90,
    delaysMatched: delays.matched,
    timeOnScreen: timeOnScreen(captions),
    shownWhilePaused: shownWhilePaused(captions),
    upgradesOnScreen: captions.filter(c => c.quality === 'better').length,
    judgeScore: await judge(video, pairs),
    sample: pairs.slice(0, 5),
    // Seconds from the end of each caption's speech to its appearance (video time).
    lateness: captions.map(c => Math.round((c.shownAt - c.lineStart) * 10) / 10),
    // Every caption as shown (video seconds), so later metrics can be computed without a re-run.
    records: captions.map(c => ({ shownAt: c.shownAt, hiddenAt: c.hiddenAt, lineStart: c.lineStart, quality: c.quality, source: c.source, text: c.text })),
    ...extra,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `audio-${run}-${mode}-${video.id}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, sample: undefined }));
  return out;
}

test.describe('audio real YouTube', () => {
  // Not the signed-in profile: there the speech model never finished loading (see docs/performance.md);
  // the sliding window is what gets past YouTube's playback limit, not the sign-in.
  test.use({ profileDir: path.join(CACHE, 'profile-captions-chrome'), headed: true });
  test.skip(browserKind() !== 'chrome', 'real YouTube runs use installed Chrome (E2E_BROWSER=chrome)');

  for (const mode of MODES) for (const video of audioVideos) {
    test(`audio benchmark ${video.id} [${mode}]`, async ({ context, configure, sw, server, tabIdOf }, testInfo) => {
      test.setTimeout(1_800_000); // includes a first-time speech model download (up to 20 min)
      await configure({ ...engineSettings(mode, server), sourceLanguage: video.lang });
      await clearTranslationState(sw);
      await recordCaptionsOnEveryLoad(context);
      const row = testInfo.parallelIndex % 2;
      const pieces = Math.ceil(video.duration / SEGMENT_S);
      const from = (k: number) => video.start + k * SEGMENT_S;
      const to = (k: number) => Math.min(video.start + video.duration, from(k + 1));
      const prepare = async (k: number) => {
        const page = await slotPage(context, k % 2, row);
        await page.goto(`https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(from(k))}s`);
        await parkAt(page, from(k));
        return page;
      };
      const captions: CaptionRecord[] = [];
      const health: any[] = [];
      reparks = 0;
      let played = 0;
      let page = await prepare(0);
      let pending: Promise<Page> | null = pieces > 1 ? prepare(1) : null;
      for (let k = 0; k < pieces; k++) {
        // One tab captures at a time: captions start in this window at the hand-over.
        await startAudioMode(sw, page, tabIdOf);
        // A build in a new folder is a new extension id with an empty model cache: the first
        // window waits (paused) for the speech model, so no run measures a model download.
        if (k === 0) await waitForSpeechModel(page, 1_200_000);
        // Play on past the piece's end while the last phrase's caption arrives (a viewer's
        // video keeps playing; pausing here would make the extension rightly drop it).
        const r = await playSegment(page, from(k), to(k) + CAPTION_TAIL_S, video.start + PAUSE_AFTER_S);
        played += Math.min(r.played, to(k) - from(k));
        health.push({
          piece: k,
          blocked: r.blocked,
          diag: await sw.evaluate(() => (self as any).__astAudioDiag?.() ?? null),
          dropped: await page.evaluate(() => JSON.parse(document.getElementById('subtitle-overlay-extension')?.dataset.dropped ?? '{}')),
          path: await page.evaluate(() => document.getElementById('subtitle-overlay-extension')?.dataset.path ?? null),
          readAhead: await page.evaluate(() => {
            const o = document.getElementById('subtitle-overlay-extension');
            return { scheduled: Number(o?.dataset.raScheduled ?? 0), dropped: JSON.parse(o?.dataset.raDropped ?? '{}'), tap: (window as any).__astAudioTapStats ?? null };
          }),
          audioTrack: await page.evaluate(() => {
            const t = (document.getElementById('movie_player') as any)?.getAudioTrack?.();
            const info: any = Object.values(t ?? {}).find((x: any) => x && typeof x === 'object' && 'isAutoDubbed' in x);
            return info ? { name: info.name, dubbed: info.isAutoDubbed } : null;
          }),
        });
        // Each piece keeps the captions whose speech ended inside it (the next window replays the tail).
        captions.push(
          ...(await shownCaptions(page))
            .filter(c => c.lineStart >= from(k) && c.lineStart < to(k))
            // Still up when this window is left: it was on screen until then.
            .map(c => ({ ...c, hiddenAt: c.hiddenAt ?? to(k) + CAPTION_TAIL_S }))
        );
        if (k + 1 < pieces) {
          const next = await pending!;
          await page.goto('about:blank');
          page = next;
          pending = k + 2 < pieces ? prepare(k + 2) : null;
        }
      }
      await page.goto('about:blank');
      const out = await audioReport('youtube', mode, video, captions, played, { health, reparks });
      expect(health.filter((h: any) => h.audioTrack?.dubbed), 'an auto-dubbed audio track played').toEqual([]);
      expect(out.captions, 'no captions appeared').toBeGreaterThan(0);
    });
  }
});

test.describe('audio local copies', () => {
  for (const mode of MODES) for (const video of audioVideos) {
    test(`audio benchmark ${video.id} (local) [${mode}]`, async ({ context, fixtureURL, configure, sw, server, tabIdOf }) => {
      test.setTimeout(600_000);
      const offset = cutOffset(video);
      await configure({ ...engineSettings(mode, server), sourceLanguage: video.lang });
      await clearTranslationState(sw);
      const page = await context.newPage();
      await page.goto(`${fixtureURL}/video-subs.html?v=${video.id}&file=${encodeURIComponent(video.id)}&stretch=b`);
      await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
      await recordCaptions(page);
      const toLocal = (t: number) => t - offset;
      await page.evaluate(t => {
        const v = document.querySelector('video')!;
        v.muted = false; // the fixture page mutes its video; a muted tab captures silence
        v.volume = 1;
        v.pause();
        v.currentTime = t;
      }, toLocal(video.start));
      await startAudioMode(sw, page, tabIdOf);
      await waitForSpeechModel(page);
      const { played } = await playWindow(page, video, toLocal);
      await page.waitForTimeout(4000);
      const captions = (await shownCaptions(page)).map(c => ({ ...c, shownAt: c.shownAt + offset, lineStart: c.lineStart + offset, hiddenAt: c.hiddenAt === null ? null : c.hiddenAt + offset }));
      const dropped = await page.evaluate(() => JSON.parse(document.getElementById('subtitle-overlay-extension')?.dataset.dropped ?? '{}'));
      const out = await audioReport('local', mode, video, captions, played, { dropped });
      expect(out.captions, 'no captions appeared').toBeGreaterThan(0);
    });
  }
});
