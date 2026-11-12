import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { readEnv } from '../helpers/env';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';
import { clearTranslationState, containsTerm, openFixture, playUntil, shownRecords, startViaPopup, timelineFixture } from '../helpers/subtitles';
import { anthropicRelayAvailable } from '../helpers/server';

// Subtitle mode against the REAL DeepL API (DEEPL_API_KEY from .env; skipped
// without it). Two runs, each measuring what its configuration represents:
//  1. latency: live path only (read-ahead off), so translation time is inside
//     the measured latency;
//  2. quality: the default configuration (read-ahead on, next-line context).
// Uses ~3k characters of DeepL quota per run.
const key = readEnv('DEEPL_API_KEY');
test.use({ mockTranslation: false, profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });
test.skip(!key, 'DEEPL_API_KEY not set in .env');

test.describe.configure({ mode: 'serial' });

test('live subtitle translation with real DeepL meets the latency target', async ({ context, fixtureURL, openPopup, configure, sw }) => {
  test.setTimeout(420_000);
  await configure({ translationProvider: 'deepl', deeplApiKey: key, targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.set({ devSubtitle: { readAhead: false } }));
  const page = await context.newPage();
  await openFixture(page, fixtureURL, 's1');
  await startViaPopup(page, openPopup);
  await playUntil(page, 179.5);

  const lines = timelineFixture.lines.filter(l => l.stretch === 's1');
  const records = await shownRecords(page);
  const latencies: number[] = [];
  const termLines = lines.filter(l => l.terms.length);
  const termMisses: string[] = [];
  let termHits = 0;
  const shown: { ko: string; en: string; reference: string }[] = [];
  for (const line of lines) {
    // The overlay shows English now, so match records by their line start instead of text.
    const match = records.find(r => r.lineStart >= line.start - 0.1 && r.lineStart <= line.end && r.shownAt <= line.end);
    if (!match) continue;
    latencies.push(match.shownAt - line.start);
    shown.push({ ko: line.ko, en: match.text, reference: line.en });
    if (line.terms.length) {
      if (line.terms.every(t => containsTerm(match.text, t))) termHits++;
      else termMisses.push(`${line.terms.join('/')} :: ${line.ko} -> ${match.text}`);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    browser: browserKind(),
    engine: 'deepl',
    lines: lines.length,
    shownLines: latencies.length,
    liveLatencyP50: sorted[Math.floor(sorted.length / 2)],
    liveLatencyP90: sorted[Math.floor(sorted.length * 0.9)],
    termHitRate: termHits / termLines.length,
    termMisses,
    shown,
  };
  console.log(JSON.stringify({ ...report, shown: undefined }, null, 1));
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-live-deepl-${browserKind()}.json`), JSON.stringify(report, null, 2));
  await page.screenshot({ path: test.info().outputPath('deepl.png') });

  // Latency including the real translation round trip (spec target).
  expect(report.liveLatencyP50).toBeLessThanOrEqual(0.7);
  // Everything displayed was actually translated (no Korean left).
  expect(shown.filter(s => /[가-힣]/.test(s.en))).toEqual([]);
});

interface TLine { start: number; end: number | null; source: string; translation: string | null; quality?: string; translatedAt: number | null; betterAt?: number | null }

test('default configuration translates every line with the key terms', async ({ context, fixtureURL, openPopup, configure, sw }) => {
  test.setTimeout(420_000);
  await configure({ translationProvider: 'deepl', deeplApiKey: key, targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.remove('devSubtitle')); // product defaults: read-ahead on
  const page = await context.newPage();
  await openFixture(page, fixtureURL, 's1');
  await startViaPopup(page, openPopup);
  await playUntil(page, 179.5);
  const timeline = await astTest<TLine[]>(page, 'mode.timeline');

  const lines = timelineFixture.lines.filter(l => l.stretch === 's1');
  const untranslated: string[] = [];
  const termMisses: string[] = [];
  const termLines = lines.filter(l => l.terms.length);
  let termHits = 0;
  const pairs: { ko: string; en: string; reference: string }[] = [];
  for (const line of lines) {
    const match = timeline.find(
      tl => tl.start >= line.start - 0.6 && tl.start <= line.end && charErrorRate(line.ko, tl.source).errors / [...line.ko.replace(/\s+/g, '')].length <= 0.5
    );
    if (!match?.translation) {
      untranslated.push(line.ko);
      continue;
    }
    pairs.push({ ko: line.ko, en: match.translation, reference: line.en });
    if (line.terms.length) {
      if (line.terms.every(t => containsTerm(match.translation!, t))) termHits++;
      else termMisses.push(`${line.terms.join('/')} :: ${line.ko} -> ${match.translation}`);
    }
  }
  const report = { browser: browserKind(), engine: 'deepl', readAhead: true, untranslated, termHitRate: termHits / termLines.length, termMisses, pairs };
  console.log(JSON.stringify({ ...report, pairs: undefined }, null, 1));
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-quality-deepl-${browserKind()}.json`), JSON.stringify(report, null, 2));

  expect(untranslated).toEqual([]);
  expect(report.termHitRate).toBeGreaterThanOrEqual(0.8);
});

// Real Claude through the fixture server's relay (credentials stay in the
// environment). Default configuration: DeepL first, then Claude; read-ahead on.
// CLAUDE_MODEL picks the model (default Opus 5.5) for the cost comparison.
const claudeModel = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';

test('real Claude: default configuration translates stretch s1 with League terms, consistently, before lines appear', async ({ context, fixtureURL, openPopup, configure, sw, server }) => {
  test.skip(!anthropicRelayAvailable(), 'no Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)');
  test.setTimeout(480_000);
  await configure({
    translationProvider: 'deepl',
    deeplApiKey: key,
    targetLanguage: 'en',
    subtitleLanguage: 'ko',
    translationEngineMode: 'fast-then-best',
    claudeModel,
    claudeAccess: 'gateway',
    claudeGatewayUrl: `${server.url}/relay/anthropic`,
    claudeGatewayToken: 'relay',
    claudeGatewayAuth: 'bearer',
  });
  await sw.evaluate(() => chrome.storage.local.remove('devSubtitle')); // product defaults: read-ahead on
  await clearTranslationState(sw);
  const page = await context.newPage();
  await openFixture(page, fixtureURL, 's1');
  await startViaPopup(page, openPopup);
  await playUntil(page, 179.5);
  const timeline = await astTest<TLine[]>(page, 'mode.timeline');
  const stored = await sw.evaluate(() => chrome.storage.local.get(null));

  const lines = timelineFixture.lines.filter(l => l.stretch === 's1');
  const untranslated: string[] = [];
  const termMisses: string[] = [];
  const termLines = lines.filter(l => l.terms.length);
  let termHits = 0;
  let claudeBefore = 0;
  let claudeBeforeSteady = 0;
  let steadyLines = 0;
  let claudeFinal = 0;
  // Cold start: the stretch plays from 0:00 the moment subtitle mode is on, so the
  // first lines arrive while OCR and Claude are still warming up. Readiness is
  // judged after this window; the all-lines figure stays in the report.
  const STEADY_AFTER_S = 8;
  const claudeLate: string[] = [];
  const pairs: { ko: string; en: string; reference: string; quality?: string }[] = [];
  const matched: { ko: string; source: string; en: string }[] = [];
  for (const line of lines) {
    const match = timeline.find(
      tl => tl.start >= line.start - 0.6 && tl.start <= line.end && charErrorRate(line.ko, tl.source).errors / [...line.ko.replace(/\s+/g, '')].length <= 0.5
    );
    if (!match?.translation) {
      untranslated.push(line.ko);
      continue;
    }
    if (match.quality === 'better') claudeFinal++;
    const ready = match.betterAt !== null && match.betterAt !== undefined && match.betterAt < line.start;
    if (line.start >= STEADY_AFTER_S) {
      steadyLines++;
      if (ready) claudeBeforeSteady++;
    }
    if (ready) claudeBefore++;
    else claudeLate.push(`${line.start.toFixed(2)}s ${line.ko} (Claude at ${match.betterAt?.toFixed(2) ?? 'never'}s)`);
    pairs.push({ ko: line.ko, en: match.translation, reference: line.en, quality: match.quality });
    matched.push({ ko: line.ko, source: match.source, en: match.translation });
    if (line.terms.length) {
      if (line.terms.every(t => containsTerm(match.translation!, t))) termHits++;
      else termMisses.push(`${line.terms.join('/')} :: ${line.ko} -> ${match.translation}`);
    }
  }

  // Glossary consistency: every learned proper name (capitalised target) is rendered
  // the same way in every line whose source contains it.
  const glossary = Object.entries(stored)
    .filter(([k]) => k.startsWith('glossary:video:'))
    .flatMap(([, v]) => v as { source: string; target: string }[]);
  const names = glossary.filter(g => /^[A-Z]/.test(g.target));
  const inconsistent: string[] = [];
  for (const name of names) {
    const using = matched.filter(m => m.source.includes(name.source));
    if (using.length < 2) continue;
    // Same names = every capitalised word of the glossary target appears ("Yi and Diana" ~ "Yi, Diana").
    const words = name.target.split(/[^\p{L}\p{N}']+/u).filter(w => /^\p{Lu}/u.test(w));
    for (const m of using) if (!words.every(w => containsTerm(m.en, w))) inconsistent.push(`${name.source}→${name.target} :: ${m.en}`);
  }

  const usage = stored.translationUsage as { lines: number; costUsd: number; byModel: Record<string, unknown> } | undefined;
  const linesPerHour = (lines.length / 180) * 3600;
  const costPerLine = usage && usage.lines ? usage.costUsd / usage.lines : null;
  const report = {
    browser: browserKind(),
    engine: 'claude',
    model: claudeModel,
    readAhead: true,
    lines: lines.length,
    untranslated,
    claudeFinalRatio: claudeFinal / lines.length,
    claudeReadyBeforeShownRatio: claudeBefore / lines.length,
    claudeReadyBeforeShownSteadyRatio: claudeBeforeSteady / steadyLines,
    claudeLate,
    termHitRate: termHits / termLines.length,
    termHits,
    termLines: termLines.length,
    termMisses,
    glossaryNames: names.length,
    inconsistent,
    usage,
    costPerLineUsd: costPerLine,
    costPerHourUsd: costPerLine !== null ? costPerLine * linesPerHour : null,
    pairs,
  };
  console.log(JSON.stringify({ ...report, pairs: undefined }, null, 1));
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-quality-claude-${claudeModel}-${browserKind()}.json`), JSON.stringify(report, null, 2));

  expect(untranslated).toEqual([]);
  expect(termHits).toBeGreaterThanOrEqual(10); // of 11 lines with key League terms (DeepL: 9)
  expect(report.claudeReadyBeforeShownSteadyRatio).toBeGreaterThanOrEqual(0.9); // after the cold-start window (see STEADY_AFTER_S)
  expect(inconsistent).toEqual([]);
  expect(report.costPerLineUsd).not.toBeNull();
});

